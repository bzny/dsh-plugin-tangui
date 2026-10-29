import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { createHostUpdateAdapter, updateProfileKey } from '../lib/update-host.js';
import { setupUpdates } from '../lib/update-integration.js';

test('real Cordis asynchronous HMR startup does not permanently disable the official installer', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const profileDir = mkdtempSync(join(parent, 'cordis-update-startup-'));
  const packageRoot = join(profileDir, 'node_modules', 'dsh-plugin-tangui'); mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-tangui': 'github:bzny/dsh-plugin-tangui#v0.5.0' } }));
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-plugin-tangui', version: '0.5.0' }));
  let complete, starting;
  const barrier = new Promise(done => { complete = done; }), started = new Promise(done => { starting = done; });
  class DelayedHmr extends Service {
    constructor(ctx) { super(ctx, 'hmr'); }
    async [Service.init]() { starting(); await barrier; }
    runExclusive() { throw new Error('capability check must not activate'); }
    reconcileProfile() { throw new Error('capability check must not activate'); }
  }
  const root = new Context();
  root.provide('profileContext', { dir: profileDir, name: 'test', installAnchor: join(profileDir, 'package.json') });
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
  try {
    const hmrFiber = root.plugin(DelayedHmr); await started;
    let updates;
    await root.plugin(ctx => {
      assert.equal(ctx.get('hmr'), undefined);
      assert.throws(() => ctx.hmr, /without inject/);
      updates = setupUpdates(ctx, { stateFile: join(profileDir, 'state.json'), isBusy: () => false,
        createAdapter(context, options) { return createHostUpdateAdapter(context, { ...options, packageRoot,
          runProfilePnpm() { throw new Error('capability check must not install'); },
          withFileLock() { throw new Error('capability check must not write packages'); },
        }); },
      });
      updates.ready();
    });
    assert.equal(updates.status().installation, 'reload-unavailable');
    assert.equal(updates.status().mode, 'check-only');
    complete(); await hmrFiber;
    const manager = shared.get(updateProfileKey(profileDir)).manager;
    manager.fetchImpl = async () => new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: `v${manager.currentVersion}` }));
    updates.check(); await manager._operation;
    assert.equal(updates.status().mode, 'managed'); assert.equal(updates.status().installation, null);
    assert.equal(updates.status().state, 'current');
  } finally {
    complete(); await root.fiber.dispose(); shared.delete(updateProfileKey(profileDir));
    assert.ok(profileDir.startsWith(parent + sep)); rmSync(profileDir, { recursive: true });
  }
});
