import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setupUpdates } from '../lib/update-integration.js';
import { updateProfileKey } from '../lib/update-host.js';

test('HMR waits for the old update, retains the gate, then adopts new updater code', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-lifecycle-'));
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
  const key = updateProfileKey(root), firstDisposers = [], nextDisposers = [];
  const make = disposers => ({ effect(setup) { disposers.push(setup()); } });
  try {
    const first = setupUpdates(make(firstDisposers), { stateFile: join(root, 'state.json'), isBusy: () => false }); first.ready();
    const coordinator = shared.get(key), oldManager = coordinator.manager;
    // An in-flight updater from before manual installation had neither method.
    oldManager.canInstall = undefined; oldManager.install = undefined;
    let finish;
    oldManager._operation = new Promise(done => { finish = () => { oldManager._operation = null; done(); }; });
    oldManager.state = 'installing';
    const release = first.gate.tryAcquireIdleLock();
    firstDisposers.forEach(dispose => dispose());
    const next = setupUpdates(make(nextDisposers), { stateFile: join(root, 'state.json'), isBusy: () => false }); next.ready();
    assert.equal(next.gate, first.gate); assert.equal(next.gate.locked, true);
    assert.equal(coordinator.manager, oldManager);
    assert.equal(next.status().canInstall, false);
    assert.throws(() => next.install({ version: '0.4.99', commit: 'a'.repeat(40) }), { code: 'update_busy' });
    oldManager.state = 'updated'; finish(); await Promise.resolve(); await Promise.resolve();
    assert.notEqual(coordinator.manager, oldManager);
    assert.equal(next.status().state, 'updated');
    release(); assert.equal(next.gate.locked, false);
    next.setAuto(false); assert.equal(next.status().auto, false);
  } finally {
    nextDisposers.forEach(dispose => dispose()); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});
