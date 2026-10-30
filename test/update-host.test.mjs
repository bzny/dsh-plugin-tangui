import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHostUpdateAdapter, scheduleOutsideProfileReload, updateProfileKey } from '../lib/update-host.js';
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

test('checks scheduled during hot reload do not inherit its transaction but retain queue serialization', async () => {
  const executing = new AsyncLocalStorage();
  let queued = false, activated = false;
  const hmr = { executing, async runExclusive(work) {
    assert.notEqual(executing.getStore(), true, 'a later timer must not appear reentrant');
    queued = true;
    return executing.run(true, work);
  } };
  await executing.run(true, async () => {
    const finished = scheduleOutsideProfileReload({ get: () => hmr }, () => new Promise((resolve, reject) => {
      setImmediate(() => hmr.runExclusive(async () => {
        assert.equal(executing.getStore(), true); activated = true;
      }).then(resolve, reject));
    }));
    assert.equal(executing.getStore(), true, 'the actual reload keeps its original scope');
    await finished;
  });
  assert.equal(queued, true); assert.equal(activated, true);
});

test('hosts without the DSH reload scope keep the ordinary timer path', () => {
  for (const ctx of [{}, { get: () => ({}) }, { get: () => ({ executing: {} }) }]) {
    assert.equal(scheduleOutsideProfileReload(ctx, () => 42), 42);
  }
});

test('host distinguishes installer errors and installed-file mismatch without persisting installer output', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'host-update-errors-'));
  const packageRoot = join(root, 'node_modules', 'dsh-plugin-tangui');
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-tangui': 'github:bzny/dsh-plugin-tangui#v0.5.2' } }));
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-plugin-tangui', version: '0.5.2' }));
  writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]');
  writeFileSync(join(packageRoot, 'lib/index.js'), 'export function apply() {}');
  const ctx = { get: name => name === 'profileContext' ? { dir: root, installAnchor: join(root, 'package.json') } : undefined };
  const commit = 'a'.repeat(40), target = { version: '0.5.3', commit, spec: `github:bzny/dsh-plugin-tangui#${commit}` };
  try {
    for (const [result, expected, details] of [
      [{ exitCode: 0, timedOut: true }, 'installer_timeout', {}],
      [{ exitCode: 3 }, 'installer_exit', { exitCode: 3 }],
      [{ exitCode: 0, incompatible: ['private dependency details'] }, 'installer_incompatible', { incompatibleCount: 1 }],
      [{ exitCode: 0 }, 'installed_version_mismatch', {}],
    ]) {
      const adapter = createHostUpdateAdapter(ctx, { packageRoot, reconcile: async () => ({}),
        withFileLock: (_path, run) => run(), runProfilePnpm: async () => ({ ...result, output: 'secret output' }) });
      await adapter.host.snapshot();
      await assert.rejects(adapter.host.install(target), error => {
        assert.equal(error.updateDiagnosticCode, expected);
        for (const [name, value] of Object.entries(details)) assert.equal(error[name], value);
        assert.doesNotMatch(JSON.stringify(error), /secret|private/);
        return true;
      });
    }
  } finally {
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});

test('Git upgrades resolve the pinned commit, including after an explicitly named offline recovery', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'host-pnpm-git-'));
  const packageRoot = join(root, 'node_modules', 'dsh-plugin-tangui');
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });
  const profileFile = join(root, 'package.json'), manifestFile = join(packageRoot, 'package.json');
  writeFileSync(profileFile, JSON.stringify({ dependencies: { 'dsh-plugin-tangui': 'github:bzny/dsh-plugin-tangui#v0.5.8', 'another-plugin': '1.0.0' } }));
  writeFileSync(manifestFile, JSON.stringify({ name: 'dsh-plugin-tangui', version: '0.5.8' }));
  writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]');
  writeFileSync(join(packageRoot, 'lib/index.js'), 'export function apply() {}');
  const ctx = { get: name => name === 'profileContext' ? { dir: root, installAnchor: profileFile } : undefined };
  const commit = 'b'.repeat(40), target = { version: '0.5.9', commit, spec: `github:bzny/dsh-plugin-tangui#${commit}` };
  const commands = [];
  try {
    const adapter = createHostUpdateAdapter(ctx, { packageRoot, reconcile: async () => ({}),
      withFileLock: (_file, run) => run(), runProfilePnpm: async (_context, args) => {
        commands.push(args);
        const spec = args.at(-1), recovery = args.includes('--offline');
        assert.ok(args.includes('--ignore-scripts'));
        if (recovery) assert.match(spec, /^dsh-plugin-tangui@file:/);
        else assert.equal(spec, target.spec, 'an alias would let pnpm incorrectly keep the previous resolution');
        const pkg = JSON.parse(readFileSync(profileFile, 'utf8'));
        pkg.dependencies['dsh-plugin-tangui'] = spec.replace(/^dsh-plugin-tangui@/, '');
        writeFileSync(profileFile, JSON.stringify(pkg));
        writeFileSync(manifestFile, JSON.stringify({ name: 'dsh-plugin-tangui', version: recovery ? '0.5.8' : '0.5.9' }));
        return { exitCode: 0 };
      } });
    const snapshot = await adapter.host.snapshot();
    await adapter.host.install(target);
    await adapter.host.restore(snapshot);
    const recovered = await adapter.host.snapshot();
    assert.equal(recovered.version, '0.5.8');
    await adapter.host.install(target);
    assert.equal(commands.length, 3);
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, '0.5.9');
    assert.equal(JSON.parse(readFileSync(profileFile, 'utf8')).dependencies['another-plugin'], '1.0.0');
  } finally {
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});
