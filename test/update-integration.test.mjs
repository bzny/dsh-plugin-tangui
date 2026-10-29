import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setupUpdates } from '../lib/update-integration.js';
import { updateProfileKey } from '../lib/update-host.js';

async function withScheduledUpdates(t, now, initialState, run) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-schedule-')), disposers = [];
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
  const key = updateProfileKey(root);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
  try {
    writeFileSync(join(root, 'plugin-update.json'), JSON.stringify(initialState));
    const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } },
      { stateFile: join(root, 'state.json'), isBusy: () => false });
    updates.ready();
    const manager = shared.get(key).manager, calls = [];
    manager.fetchImpl = async url => {
      calls.push(url);
      return new Response(JSON.stringify({ tag_name: `v${updates.status().current}`, draft: false, prerelease: false }));
    };
    await run({ updates, manager, calls });
  } finally {
    disposers.forEach(dispose => dispose()); shared.delete(key); t.mock.timers.reset();
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
}

test('startup timer stays silent overnight, manual check works, and overdue check resumes after 07:00', async t => {
  await withScheduledUpdates(t, Date.parse('2026-10-29T01:00:00+08:00'), {}, async ({ updates, manager, calls }) => {
    t.mock.timers.tick(2000); await Promise.resolve();
    assert.equal(calls.length, 0); assert.equal(updates.status().lastCheck, null);
    updates.check(); await manager._operation; assert.equal(calls.length, 1);
    t.mock.timers.setTime(Date.parse('2026-10-29T07:00:00+08:00'));
    t.mock.timers.tick(15000); await manager._operation;
    assert.equal(calls.length, 2);
    t.mock.timers.tick(15000); await Promise.resolve(); assert.equal(calls.length, 2);
  });
});

test('startup timer honors a recent persisted check and the hourly interval', async t => {
  const now = Date.parse('2026-10-29T10:00:00+08:00');
  await withScheduledUpdates(t, now, { lastCheck: now - 30 * 60 * 1000 }, async ({ manager, calls }) => {
    t.mock.timers.tick(2000); await Promise.resolve(); assert.equal(calls.length, 0);
    t.mock.timers.tick(30 * 60 * 1000 - 2000); await manager._operation;
    assert.equal(calls.length, 1);
    t.mock.timers.tick(59 * 60 * 1000); await Promise.resolve(); assert.equal(calls.length, 1);
    t.mock.timers.tick(60 * 1000); await manager._operation; assert.equal(calls.length, 2);
  });
});

test('auto disabled prevents both startup and interval checks', async t => {
  await withScheduledUpdates(t, Date.parse('2026-10-29T10:00:00+08:00'), { auto: false }, async ({ updates, manager, calls }) => {
    t.mock.timers.tick(2 * 60 * 60 * 1000); await Promise.resolve(); assert.equal(calls.length, 0);
    updates.check(); await manager._operation; assert.equal(calls.length, 1);
    assert.equal(updates.status().auto, false);
  });
});

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
