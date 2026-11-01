import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setupUpdates } from '../lib/update-integration.js';
import { updateProfileKey } from '../lib/update-host.js';

async function withStorageState(contents, run) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-storage-')), disposers = [], diagnostics = [];
  const file = join(root, 'plugin-update.json'); writeFileSync(file, contents);
  const key = updateProfileKey(root), shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v0.0.0' }));
  try {
    const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } }, {
      stateFile: join(root, 'state.json'), isBusy: () => false, diagnostic: row => diagnostics.push(row),
    });
    updates.ready();
    await run({ updates, file, diagnostics, coordinator: shared.get(key) });
  } finally {
    globalThis.fetch = nativeFetch;
    disposers.forEach(dispose => dispose()); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
}

test('a UTF-8 BOM does not invalidate otherwise valid updater settings', async () => {
  await withStorageState('\uFEFF' + JSON.stringify({ auto: true }), async ({ updates, file }) => {
    assert.equal(updates.status().storageError, null);
    assert.equal(updates.status().auto, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).auto, true);
  });
});

test('manual check reloads a repaired settings file without resetting durable failure history or enabling auto', async () => {
  await withStorageState('PRIVATE_INVALID_JSON', async ({ updates, file, coordinator, diagnostics }) => {
    assert.equal(updates.status().storageError, 'update_settings_invalid');
    assert.equal(readFileSync(file, 'utf8'), 'PRIVATE_INVALID_JSON');
    writeFileSync(file, JSON.stringify({ auto: true, blockedVersion: '99.0.0',
      retry: { version: '99.0.0', commit: 'a'.repeat(40), attempts: 2, nextAt: Date.now() + 3600000 } }));
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: `v${updates.status().current}` })); };
    try {
      updates.check(); await coordinator.manager._operation;
    } finally { globalThis.fetch = original; }
    assert.equal(calls, 1);
    assert.equal(updates.status().storageError, null);
    assert.equal(updates.status().auto, false, 'repair does not silently re-enable automatic installation');
    assert.equal(updates.status().blockedVersion, '99.0.0');
    assert.equal(updates.status().retry.attempts, 2);
    assert.equal(updates.status().current, JSON.parse(readFileSync(file, 'utf8')).current);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_INVALID_JSON|update-storage-|state\.json/);
  });
});

test('saving auto settings can recover a corrected file, while malformed files remain preserved', async () => {
  await withStorageState('PRIVATE_INVALID_JSON', async ({ updates, file, diagnostics }) => {
    assert.throws(() => updates.setAuto(true), /update_settings_invalid/);
    assert.equal(readFileSync(file, 'utf8'), 'PRIVATE_INVALID_JSON');
    assert.deepEqual(updates.status().storageDiagnostic, { stage: 'read', code: 'invalid_json' });
    writeFileSync(file, JSON.stringify({ auto: false }));
    updates.setAuto(true);
    assert.equal(updates.status().storageError, null);
    assert.equal(updates.status().storageDiagnostic, null);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).auto, true);
    assert.ok(diagnostics.some(row => row.event === 'storage' && row.code === 'invalid_json'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_INVALID_JSON/);
  });
});

test('settings repair cannot claim an edited running version or revive a saved activity', async () => {
  await withStorageState('PRIVATE_INVALID_JSON', async ({ updates, file, coordinator }) => {
    const active = updates.status().current;
    coordinator.continuation = null; coordinator.resumeState = null;
    writeFileSync(file, JSON.stringify({ current: '99.0.0', auto: true,
      continuation: { options: { mode: 'watch' } }, resumeState: 'pending' }));
    updates.setAuto(false);
    assert.equal(updates.status().current, active);
    assert.equal(updates.status().auto, false);
    assert.equal(coordinator.continuation, null);
    assert.equal(coordinator.resumeState, null);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).current, active);
  });
});

async function withScheduledUpdates(t, now, initialState, run, createAdapter) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-schedule-')), disposers = [];
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
  const key = updateProfileKey(root);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
  try {
    writeFileSync(join(root, 'plugin-update.json'), JSON.stringify(initialState));
    const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } },
      { stateFile: join(root, 'state.json'), isBusy: () => false, ...(createAdapter ? { createAdapter } : {}) });
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

test('normal startup timer refreshes a late host without requiring a manual click', async t => {
  let available = false;
  const host = {};
  await withScheduledUpdates(t, Date.parse('2026-10-29T10:00:00+08:00'), {}, async ({ updates, manager, calls }) => {
    assert.equal(updates.status().installation, 'reload-unavailable');
    available = true;
    t.mock.timers.tick(2000); await manager._operation;
    assert.equal(updates.status().mode, 'managed'); assert.equal(updates.status().installation, null);
    assert.equal(manager.host, host); assert.equal(calls.length, 1);
  }, () => available ? { mode: 'managed', reason: null, host } : { mode: 'check-only', reason: 'reload-unavailable', host: null });
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
    coordinator.persist = () => {}; // Simulate the legacy writer retained by HMR.
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
    coordinator.continuation = { version: 1, options: { mode: 'watch' } };
    coordinator.resumeState = 'pending'; coordinator.persist(coordinator.manager.status());
    assert.equal(JSON.parse(readFileSync(join(root, 'plugin-update.json'), 'utf8')).continuation.options.mode, 'watch');
  } finally {
    nextDisposers.forEach(dispose => dispose()); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});

test('late DSH update service recovers on manual check and installs with the same idle gate', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-late-host-')), disposers = [];
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')], key = updateProfileKey(root);
  let available = false, activeVersion, constructions = 0;
  const calls = [];
  try {
    const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } }, {
      stateFile: join(root, 'state.json'), isBusy: () => false,
      createAdapter(_ctx, options) {
        constructions++;
        if (!available) return { mode: 'check-only', reason: 'reload-unavailable', profileDir: root, host: null };
        return { mode: 'managed', reason: null, profileDir: root, host: {
          tryAcquireIdleLock: options.tryAcquireIdleLock,
          async snapshot() { calls.push('snapshot'); assert.equal(updates.gate.locked, true); return {}; },
          async install(target) { calls.push('install'); activeVersion = target.version; },
          async activate() { calls.push('activate'); },
          getActiveVersion() { return activeVersion; }, async restore() { calls.push('restore'); },
        } };
      },
    });
    updates.ready();
    assert.equal(updates.status().installation, 'reload-unavailable');
    assert.equal(updates.status().mode, 'check-only');
    const manager = shared.get(key).manager, baseline = manager.currentManifest;
    const version = `${Number(baseline.version.split('.')[0]) + 1}.0.0`, commit = 'a'.repeat(40);
    manager.fetchImpl = async url => new Response(JSON.stringify(url.endsWith('/releases/latest') ?
      { draft: false, prerelease: false, tag_name: `v${version}` } : url.includes('/git/ref/tags/') ?
      { object: { type: 'commit', sha: commit } } : { ...baseline, version }));
    updates.check(); await manager._operation;
    assert.equal(updates.status().reason, 'host_check_only');
    assert.equal(JSON.parse(readFileSync(join(root, 'plugin-update.json'), 'utf8')).installation, 'reload-unavailable');
    available = true;
    updates.check(); await manager._operation;
    assert.equal(updates.status().mode, 'managed'); assert.equal(updates.status().installation, null);
    assert.equal(updates.status().reason, null); assert.equal(updates.status().canInstall, true);
    updates.install({ version, commit }); await manager._operation;
    assert.deepEqual(calls, ['snapshot', 'install', 'activate']);
    assert.equal(updates.status().state, 'updated'); assert.equal(updates.gate.locked, false);
    assert.ok(constructions >= 4);
  } finally {
    disposers.forEach(dispose => dispose()); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});

test('host capability refresh does not replace an in-flight installation or recovery', async () => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-host-owner-')), disposers = [];
  const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')], key = updateProfileKey(root);
  let count = 0;
  try {
    const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } }, {
      stateFile: join(root, 'state.json'), isBusy: () => false,
      createAdapter() { count++; return { mode: 'check-only', reason: 'reload-unavailable', profileDir: root, host: null }; },
    });
    updates.ready();
    const manager = shared.get(key).manager, before = count;
    let finish; manager._operation = new Promise(done => { finish = done; });
    updates.check(); assert.equal(count, before);
    finish(); await manager._operation; manager._operation = null;
    const release = updates.gate.tryAcquireIdleLock();
    updates.ready(); assert.equal(count, before); release();
  } finally {
    disposers.forEach(dispose => dispose()); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
});
