import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CommunityRuntime } from '../lib/runtime.js';
import { GameRuntime, GAME_PROTOCOL } from '../lib/game-runtime.js';
import { setupUpdates } from '../lib/update-integration.js';
import { updateProfileKey } from '../lib/update-host.js';
import { apply } from '../lib/index.js';

const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check) { for (let n = 0; n < 400; n++) { if (check()) return; await delay(5); } throw new Error('boundary timeout'); }
const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')];
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const version = `${Number(manifest.version.split('.')[0]) + 1}.0.0`, commit = 'a'.repeat(40);

function fixture(t, { game = false, reflection } = {}) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-runtime-')), stateFile = join(root, 'state.json');
  const binding = { baseUrl: 'http://127.0.0.1:4999', actorId: 'fixture-ai', grantId: 'fixture-grant', token: 'FAKE_LOCAL_ONLY',
    scopes: ['posts:read', 'events:read', 'comments:write', 'games:play'] };
  const actor = { id: binding.actorId, name: '测试伙伴', kind: 'ai', relationship: 'independent' };
  const room = { id: 'fixture-room', game_id: 'fixture-game', game_version: '1', rules_version: '1', status: 'playing' };
  const remote = { acquired: 0, released: 0, holder: null, ended: false, gameReads: 0, reflections: 0, installs: 0, failInstall: false, restart: false };
  const send = (data, extra = {}) => new Response(JSON.stringify({ data, ...extra }));
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    if (String(url).startsWith('https://')) return new Response(JSON.stringify(String(url).endsWith('/releases/latest') ?
      { tag_name: `v${version}`, draft: false, prerelease: false } : String(url).includes('/git/ref/tags/') ?
        { object: { type: 'commit', sha: commit } } : { ...manifest, version }));
    if (path === '/api/v1/me') return send({ actor, scopes: binding.scopes });
    if (path === '/api/v1/capabilities') return send({ features: { game_experience: game } });
    if (path === '/api/v1/agent/control/acquire') {
      assert.equal(remote.holder, null, 'old controller must release before resume');
      remote.holder = JSON.parse(request.body).instance_id; remote.acquired++;
      return send({ active: true, owned_by_current_grant: true, actor_id: actor.id, epoch: remote.acquired,
        server_time: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), renew_after_seconds: 15 });
    }
    if (path === '/api/v1/agent/control/release') { remote.holder = null; remote.released++; return send({ active: false }); }
    if (path === '/api/v1/agent/configuration') return send({ actor, persona: { description: '测试人设', effective:
      Object.fromEntries(['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'].map(k => [k, ''])) } });
    if (path === '/api/v1/posts') return send([], { next_cursor: null });
    if (path === '/api/v1/events') return send([], { next_cursor: '0' });
    if (path === '/api/v1/agent/game-assignment') return send({ room: game && !remote.ended ? room : null });
    if (path === '/api/v1/agent/game-invitations') return send({ invitations: [] });
    if (path === '/api/v1/games/fixture-game/manifest') return send({ protocol: GAME_PROTOCOL, id: room.game_id, version: '1', rules_version: '1' });
    if (path === '/api/v1/game-rooms/fixture-room/state') {
      remote.gameReads++;
      return send({ protocol: GAME_PROTOCOL, room: { ...room, status: remote.ended ? 'finished' : 'playing' },
        observation: {}, action_request: null, rules: {}, seq: remote.gameReads, server_time: new Date().toISOString(), result: remote.ended ? { winner: actor.id } : null });
    }
    if (path === '/api/v1/game-rooms/fixture-room/experience') return send({ room: { ...room, status: 'finished' },
      can_share: false, participants: [{ actor_id: actor.id }], public_view: {}, public_result: { winner: actor.id } });
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  };
  const instances = [], makeRuntime = () => {
    const gameRuntime = new GameRuntime({ bridge: {}, stateFile: `${stateFile}.games.json`, fetchImpl, decide: () => assert.fail('no turn request') });
    const runtime = new CommunityRuntime({ directory: join(root, 'runtime'), connection: { binding: () => binding }, gameRuntime,
      fetchImpl, decide: () => assert.fail('no community posts'), lifeModel: async (...args) => {
        remote.reflections++; if (reflection) return reflection(...args);
        return { reflection: '本局已经结束，稍作休息。', state: { mood: 60, interest: 50, pressure: 30 }, baseline: null,
          goal: '稍后继续观察', note: '', impressions: [], next_activity: 'rest', choice_index: 0, draft: null };
      } });
    instances.push(runtime); return runtime;
  };
  const implementations = [], key = updateProfileKey(root);
  let activeVersion = manifest.version, current;
  const make = () => {
    const runtime = makeRuntime(), disposers = [];
    const ctx = { effect(setup) { disposers.push(setup()); } };
    const createAdapter = (_ctx, options) => ({ mode: 'managed', reason: null, profileDir: root, host: {
      tryAcquireIdleLock: options.tryAcquireIdleLock,
      async snapshot() {
        assert.equal(runtime.busyForUpdate(), false);
        assert.equal(current.updates.gate.locked, true); return {};
      },
      async install() { remote.installs++; if (remote.failInstall) throw new Error('fixture install failure'); activeVersion = version; if (remote.restart) return { restartRequired: true }; },
      async activate() {
        const old = current;
        old.runtime.stop('host_stopped'); await old.runtime.settled();
        old.disposers.forEach(dispose => dispose());
        current = make();
        assert.equal(current.runtime.running(), false, 'new code must wait for version verification and unlocked gate');
      },
      getActiveVersion: () => activeVersion,
      async restore() { activeVersion = manifest.version; },
    } });
    const updates = setupUpdates(ctx, { stateFile, runtime, isBusy: () => runtime.busyForUpdate(), createAdapter });
    const value = { runtime, updates, disposers }; implementations.push(value);
    updates.ready(); shared.get(key).manager.fetchImpl = fetchImpl;
    return value;
  };
  current = make();
  const check = async () => { current.updates.check(); await shared.get(key).manager._operation; };
  const install = async () => { current.updates.install({ version, commit }); await shared.get(key).manager._operation; await delay(0); };
  const tick = async () => { await shared.get(key).manager.tick({ install: true }); await delay(0); };
  t.after(async () => {
    for (const instance of instances) { instance.stop(); await instance.settled(); }
    implementations.forEach(i => i.disposers.forEach(dispose => dispose())); shared.delete(key);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  });
  return { root, stateFile, key, remote, binding, fetchImpl, makeRuntime, check, install, tick,
    current: () => current, coordinator: () => shared.get(key) };
}

test('actual runtime is transferred across HMR only after verification; continuation is local, credential-free and consumed once', async t => {
  const f = fixture(t), first = f.current();
  first.runtime.start({ mode: 'watch', interval_seconds: 3600, max_model_calls: 31 });
  await until(() => first.runtime.detail === 'waiting'); await f.check(); await f.install();
  assert.equal(first.updates.status().state, 'waiting_idle'); await until(() => first.runtime.updateParked);
  await f.tick(); await until(() => f.current().runtime.detail === 'waiting');
  const next = f.current(); assert.notEqual(next, first);
  assert.equal(next.updates.status().state, 'updated'); assert.equal(next.updates.status().resumeState, 'resumed');
  assert.equal(next.runtime.limits.max_model_calls, 31); assert.equal(next.runtime.pollInterval, 3600000);
  assert.equal(f.remote.acquired, 2); assert.equal(f.remote.released, 1); assert.equal(f.remote.installs, 1);
  const saved = readFileSync(join(f.root, 'plugin-update.json'), 'utf8');
  assert.doesNotMatch(saved, /FAKE_LOCAL_ONLY|测试人设/); assert.equal(JSON.parse(saved).continuation, null);
  f.coordinator().reconcile(); assert.equal(f.remote.acquired, 2);
});

test('a whole game finishes before updating, and its not-yet-started reflection runs in the new runtime', async t => {
  const f = fixture(t, { game: true }), first = f.current();
  first.runtime.start({ mode: 'watch', interval_seconds: 3600 });
  await until(() => first.runtime.gameInProgress()); await f.check(); await f.install();
  await delay(20); assert.equal(first.runtime.updateParked, false); assert.equal(f.remote.installs, 0);
  assert.ok(first.runtime.activity.view().actions.some(a => a.type === 'game'));
  f.remote.ended = true; await until(() => first.runtime.updateParked);
  assert.equal(f.remote.reflections, 0); assert.equal(first.runtime.gameRuntime.state.lastFinishedRoom, 'fixture-room');
  await f.tick(); await until(() => f.remote.reflections === 1 && f.current().runtime.detail === 'waiting');
  const next = f.current().runtime, record = next.state.companion_life.attempts['room:fixture-room'];
  assert.equal(record.status, 'completed'); assert.equal(record.handled, true);
  assert.equal(f.remote.reflections, 1); assert.equal(f.remote.installs, 1);
});

test('a reflection already generating is saved before update and never regenerated afterward', async t => {
  let finish;
  const f = fixture(t, { game: true, reflection: () => new Promise(done => { finish = done; }) }), first = f.current();
  first.runtime.start({ mode: 'watch', interval_seconds: 3600 }); await until(() => first.runtime.gameInProgress());
  f.remote.ended = true; await until(() => !!finish);
  await f.check(); await f.install(); assert.equal(first.runtime.updateParked, false); assert.equal(f.remote.installs, 0);
  finish({ reflection: '已完成而未处理的复盘', state: { mood: 60, interest: 50, pressure: 30 }, baseline: null,
    goal: '接着观察', note: '', impressions: [], next_activity: 'rest', choice_index: 0, draft: null });
  await until(() => first.runtime.updateParked);
  assert.equal(first.runtime.state.companion_life.attempts['room:fixture-room'].status, 'completed');
  await f.tick(); await until(() => f.current().runtime.detail === 'waiting');
  assert.equal(f.remote.reflections, 1);
  assert.equal(f.current().runtime.state.companion_life.attempts['room:fixture-room'].handled, true);
});

test('rollback restores observation; disabling automatic installation while waiting releases the pause', async t => {
  const f = fixture(t), first = f.current(); first.runtime.start({ mode: 'watch', interval_seconds: 3600 });
  await until(() => first.runtime.detail === 'waiting'); await f.check();
  // Automatic, not an explicit one-time manual request.
  await f.tick(); await until(() => first.runtime.updateParked);
  first.updates.setAuto(false); await until(() => first.runtime.detail === 'waiting' && !first.runtime.updateParked);
  assert.equal(f.remote.installs, 0); assert.equal(f.remote.acquired, 1);
  f.remote.failInstall = true; await f.install(); await until(() => first.runtime.updateParked); await f.tick();
  await until(() => f.current().runtime.detail === 'waiting');
  assert.equal(f.current().updates.status().state, 'rolled_back'); assert.equal(f.remote.acquired, 2);
});

test('restart-required keeps the continuation and only the confirmed version resumes after process replacement', async t => {
  const f = fixture(t), first = f.current(); first.runtime.start({ mode: 'watch', interval_seconds: 3600 });
  await until(() => first.runtime.detail === 'waiting'); f.remote.restart = true;
  await f.check(); await f.install(); await until(() => first.runtime.updateParked); await f.tick();
  assert.equal(first.updates.status().state, 'restarting_needed');
  const saved = JSON.parse(readFileSync(join(f.root, 'plugin-update.json'), 'utf8'));
  assert.equal(saved.continuation.options.mode, 'watch'); assert.equal(f.remote.acquired, 1);
  assert.doesNotMatch(JSON.stringify(saved), /FAKE_LOCAL_ONLY/);
  first.runtime.stop('host_stopped'); await first.runtime.settled(); first.disposers.forEach(d => d());
  shared.delete(f.key);
  // This source fixture has the original manifest. Simulate disk confirming
  // that version after a restart-required rollback, using the real constructor.
  writeFileSync(join(f.root, 'plugin-update.json'), JSON.stringify({ ...saved, pendingVersion: manifest.version, rollbackPending: true }));
  const runtime = f.makeRuntime(), disposers = [];
  const updates = setupUpdates({ effect(setup) { disposers.push(setup()); } }, { stateFile: f.stateFile, runtime, isBusy: () => runtime.busyForUpdate() });
  updates.ready(); await until(() => runtime.detail === 'waiting');
  assert.equal(updates.status().resumeState, 'resumed'); assert.equal(f.remote.acquired, 2);
  disposers.forEach(d => d());
});

test('real plugin apply wires observation boundaries and durable pending work into the update gate', async t => {
  const f = fixture(t), nativeFetch = globalThis.fetch, disposers = [];
  const pluginRoot = join(f.root, 'apply'); mkdirSync(pluginRoot);
  const stateFile = join(pluginRoot, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ version: 1, enabled: false, memoryDir: '', baseUrl: f.binding.baseUrl, binding: f.binding }));
  globalThis.fetch = f.fetchImpl;
  try {
    apply({ effect(setup) { disposers.push(setup()); }, inject() {} }, { stateFile });
    const coordinator = shared.get(updateProfileKey(pluginRoot)), runtime = coordinator.runtime;
    runtime.start({ mode: 'watch', interval_seconds: 3600 }); await until(() => runtime.detail === 'waiting');
    assert.equal(coordinator.gate.tryAcquireIdleLock(), null);
    runtime.requestUpdatePause(); await until(() => runtime.updateParked);
    // Stored, not executing: neither a queued draft nor a deferred reply is an
    // in-flight action. The exact bytes/keys remain in runtime state.
    runtime.commit({ draft_request: { key: 'fixture-draft-key', payload: { title: '待审', body: '已保存' } } });
    const release = coordinator.gate.tryAcquireIdleLock(); assert.equal(typeof release, 'function');
    assert.throws(() => coordinator.gate.enter(), { code: 'plugin_updating' }); release();
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.();
    globalThis.fetch = nativeFetch; shared.delete(updateProfileKey(pluginRoot));
  }
});
