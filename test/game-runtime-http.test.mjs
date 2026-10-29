import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GameRuntime } from '../lib/game-runtime.js';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const ACTOR = { id: 'fixture-ai', kind: 'ai', name: '隔离测试伙伴' };
const GAME_TOKEN = 'FIXTURE_ONLY_GAME_TOKEN';
const COMMUNITY_TOKEN = 'FIXTURE_ONLY_COMMUNITY_TOKEN';
const PERSONA = { description: '我是提督的秘书舰，喜欢认真思考游戏。', effective: { role: '秘书舰' } };
const ISO = (ms) => new Date(ms).toISOString();
const pause = (ms = 5) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function fixture(t, { decide = async () => ({ action_id: 'pass', commentary: '提督，我先观察。' }) } = {}) {
  const root = join(TEST_ROOT, `game-http-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const stateFile = join(root, 'game-state.json');
  let time = 1_800_000_000_000, monotonic = 10000;
  const calls = [], violations = [], modelCalls = [];
  const remote = {
    approved: false, scopes: ['games:play'], actor: { ...ACTOR }, accepted: false,
    ready: false, renewals: 0, dropActionResponse: false, actions: new Map(), request: null,
    instanceId: null, epoch: 6,
    room: { id: 'fixture-room', game_id: 'fixture-game', game_version: '1.2.3', rules_version: 'rules-v1',
      name: '隔离HTTP测试桌', status: 'waiting', seats: [], settings: {} },
  };
  const manifest = { protocol: 'carbon-silicon.turn-game.v1', id: 'fixture-game', version: '1.2.3', rules_version: 'rules-v1',
    title: '隔离HTTP游戏', player_count: { min: 1, max: 1 }, decision_seconds: 35 };
  const send = (response, data) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data }));
  };
  const fail = (response, code, status = 409) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code, message: '隔离服务响应' } }));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const call = { method: request.method, path: url.pathname, query: url.searchParams,
        headers: { ...request.headers }, body };
      calls.push(call);
      assert.notEqual(call.headers.authorization, `Bearer ${COMMUNITY_TOKEN}`, 'community-only token was used for game work');
      if (url.pathname === '/api/v1/pairings') {
        assert.equal(request.method, 'POST');
        assert.equal(call.headers.authorization, undefined);
        return send(response, { device_code: 'FIXTURE_GAME_DEVICE', user_code: 'GAME-CODE', expires_in: 600, interval: 1 });
      }
      if (url.pathname === '/api/v1/pairings/token') {
        assert.equal(call.headers.authorization, undefined);
        return remote.approved
          ? send(response, { token: GAME_TOKEN, actor_id: remote.actor.id, grant_id: 'fixture-game-grant' })
          : fail(response, 'authorization_pending');
      }
      assert.equal(call.headers.authorization, `Bearer ${GAME_TOKEN}`, 'game token was not used');
      if (url.pathname === '/api/v1/me') return send(response, { actor: remote.actor, scopes: remote.scopes });
      if (url.pathname === '/api/v1/agent/configuration') return send(response, { actor: remote.actor, persona: PERSONA, revision: 1 });
      if (url.pathname === '/api/v1/agent/control/acquire' || url.pathname === '/api/v1/agent/control/renew') {
        assert.equal(body.instance_id, bridge.state.instanceId);
        if (url.pathname.endsWith('/acquire') && remote.instanceId !== body.instance_id) {
          remote.instanceId = body.instance_id;
          remote.epoch++;
        }
        if (url.pathname.endsWith('/renew')) remote.renewals++;
        return send(response, { actor_id: ACTOR.id, active: true, owned_by_current_grant: true, epoch: remote.epoch,
          server_time: ISO(time), expires_at: ISO(time + 60000), renew_after_seconds: 15 });
      }
      if (url.pathname === '/api/v1/agent/control/release') return send(response, { active: false });
      if (url.pathname === '/api/v1/agent/game-assignment') return send(response, { room: remote.accepted ? remote.room : null });
      if (url.pathname === '/api/v1/agent/game-invitations') return send(response, {
        invitations: [{ id: 'fixture-invitation', room_id: remote.room.id, status: 'pending', name: '隔离邀请' }],
        active_rooms: [], auto_accept: false,
      });
      if (url.pathname === '/api/v1/games/fixture-game/manifest') {
        assert.equal(url.searchParams.get('version'), '1.2.3');
        return send(response, manifest);
      }
      if (url.pathname === '/api/v1/games/fixture-game/rules') return send(response, { id: 'rules-v1', version: 'rules-v1', text: '选择合法动作。', markdown: '选择合法动作。' });
      if (url.pathname === '/api/v1/game-rooms/fixture-room/ready') {
        assert.equal(remote.accepted, true, 'pending invitation was silently accepted');
        assert.deepEqual(body, { game_version: '1.2.3', rules_version: 'rules-v1' });
        remote.ready = true;
        remote.room.seats = [{ seat_id: 0, actor_id: ACTOR.id, kind: 'ai', ready: true }];
        return send(response, remote.room);
      }
      if (url.pathname === '/api/v1/game-rooms/fixture-room/state') {
        const observation = { revision: 3, self: { private_marker: 'my-visible-state' } };
        return send(response, { protocol: 'carbon-silicon.turn-game.v1', room: remote.room,
          observation, view: observation, action_request: remote.request,
          rules: { id: 'rules-v1', text: '选择合法动作。' }, server_time: ISO(time), seq: 3 });
      }
      if (url.pathname === '/api/v1/game-rooms/fixture-room/actions') {
        assert.equal(call.headers['x-ai-instance-id'], remote.instanceId);
        assert.equal(call.headers['x-ai-control-epoch'], String(remote.epoch));
        const key = call.headers['idempotency-key'];
        assert.ok(key);
        const previous = remote.actions.get(key);
        if (previous) {
          assert.deepEqual(body, previous.body);
          return send(response, previous.result);
        }
        assert.ok(remote.request, 'new action sent without an open request');
        assert.ok(time < Date.parse(remote.request.deadline_at), 'late model decision was submitted');
        assert.equal(body.request_id, remote.request.request_id);
        assert.equal(body.based_on_revision, remote.request.based_on_revision);
        assert.ok(remote.request.legal_actions.some((action) => action.action_id === body.decision.action_id));
        const result = { status: 'accepted', request_id: body.request_id, decision: body.decision };
        remote.actions.set(key, { body, result });
        remote.request = null;
        if (remote.dropActionResponse) {
          remote.dropActionResponse = false;
          response.destroy();
          return;
        }
        return send(response, result);
      }
      assert.fail(`unexpected HTTP request: ${request.method} ${url.pathname}`);
    } catch (error) {
      violations.push(error);
      if (!response.destroyed && !response.headersSent) fail(response, 'fixture_assertion', 500);
      else response.destroy();
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const bridge = { state: { baseUrl, instanceId: 'fixture-dsh-instance',
    binding: { actorId: ACTOR.id, token: COMMUNITY_TOKEN, grantId: 'fixture-community-grant' } }, busy: false };
  const runtimes = [];
  const makeRuntime = () => {
    const runtime = new GameRuntime({ bridge, stateFile, automatic: false, now: () => time, monotonic: () => monotonic,
      decide: async (snapshot, options) => { modelCalls.push({ snapshot, options }); return decide(snapshot, options); } });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = makeRuntime();
  t.after(async () => {
    for (const instance of runtimes) await instance.stop();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    const child = relative(TEST_ROOT, resolve(root));
    assert.ok(child && !child.startsWith('..') && !child.includes(':'));
    rmSync(root, { recursive: true });
    assert.deepEqual(violations.map((error) => error.message), []);
  });
  return { runtime, remote, calls, modelCalls, bridge, stateFile, baseUrl,
    restart(instanceId) { bridge.state.instanceId = instanceId; return makeRuntime(); },
    advance(ms) { time += ms; monotonic += ms; },
    saved() { return JSON.parse(readFileSync(stateFile, 'utf8')); },
    count(path) { return calls.filter((call) => call.path === path).length; },
    request(requestId = 'fixture-turn-1') {
      remote.room.status = 'playing';
      remote.request = { request_id: requestId, based_on_revision: 3, phase: 'response',
        deadline_at: ISO(time + 35000), legal_actions: [{ action_id: 'pass', type: 'pass' }],
        default_action: { action_id: 'pass' } };
      return remote.request;
    },
  };
}

async function connect(f, maxModelCalls = 5) {
  await f.runtime.start({ maxModelCalls });
  assert.equal(f.count('/api/v1/pairings'), 1);
  f.remote.approved = true;
  f.advance(5000);
  for (let attempt = 0; attempt < 5 && f.count('/api/v1/agent/control/acquire') === 0; attempt++) await f.runtime.step();
  assert.equal(f.count('/api/v1/agent/control/acquire'), 1);
}

async function ready(f) {
  f.remote.accepted = true;
  for (let attempt = 0; attempt < 5 && !f.remote.ready; attempt++) await f.runtime.step();
  assert.equal(f.remote.ready, true);
}

async function settle(f, predicate) {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt++) {
    await f.runtime.step();
    await pause();
  }
  assert.equal(Boolean(predicate()), true, 'runtime did not reach the expected isolated state');
}

test('shared community recovery rereads the game and discards a decision past its original deadline', async t => {
  let finish;
  const f = await fixture(t, { decide: () => new Promise(resolve => { finish = resolve; }) });
  await connect(f); await ready(f); f.request();
  await settle(f, () => !!finish);
  const game = f.runtime, oldDeadline = game.active.deadline;
  let recovered = 0;
  const owner = {
    instanceId: f.bridge.state.instanceId, lease: game.lease, abort: new AbortController(),
    recoverable: () => true,
    checkActive() { assert.ok(game.monotonic() < this.lease.deadline); },
    connectionReady: async () => {},
    proof() { this.checkActive(); return { 'X-AI-Instance-ID': this.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) }; },
    async recoverConnection() {
      recovered++; f.advance(40000);
      finish({ action_id: 'pass', commentary: '旧回合结果' });
      await game.active.promise;
      this.lease = { ...this.lease, deadline: game.monotonic() + 60000 };
    },
  };
  game.sessionOwner = owner; game.ownerAbort = () => game.abort.abort();
  const originalFetch = game.fetch;
  let failNext = true;
  game.fetch = (...args) => {
    if (failNext) { failNext = false; throw new TypeError('fixture disconnected socket'); }
    return originalFetch(...args);
  };
  await game.step();
  assert.equal(recovered, 1); assert.equal(game.busy, true);
  assert.equal(game.active.deadline, oldDeadline);
  assert.equal(f.remote.actions.size, 0);
  await game.step();
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.remote.actions.size, 0);
  assert.equal(f.saved().journals['fixture-room'].requests['fixture-turn-1'].status, 'discarded_late');
  assert.equal(f.saved().journals['fixture-room'].requests['fixture-turn-1'].reason, 'expired');
});

test('game access pairs separately and a pending invitation never triggers accept, ready or model calls', async (t) => {
  const f = await fixture(t);
  await connect(f);
  await f.runtime.step();
  await f.runtime.step();
  assert.ok(f.count('/api/v1/agent/game-assignment') >= 1);
  assert.equal(f.remote.ready, false);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.calls.some((call) => /\/respond$|\/join$|\/ready$/.test(call.path)), false);
  assert.doesNotMatch(JSON.stringify(f.runtime.status()), /FIXTURE_ONLY_GAME_TOKEN|FIXTURE_GAME_DEVICE|FIXTURE_ONLY_COMMUNITY_TOKEN/);
  assert.equal(f.bridge.state.binding.token, COMMUNITY_TOKEN);
});

test('a wrong AI identity or missing games permission stops before acquiring control', async (t) => {
  for (const scenario of ['identity', 'scope']) {
    const f = await fixture(t);
    await f.runtime.start({ maxModelCalls: 5 });
    f.remote.approved = true;
    if (scenario === 'identity') f.remote.actor.id = 'different-fixture-ai';
    else f.remote.scopes = ['persona:write'];
    f.advance(5000);
    await f.runtime.step();
    assert.equal(f.runtime.status().status, scenario === 'identity' ? 'game_identity_mismatch' : 'game_scope_required');
    assert.equal(f.runtime.status().running, false);
    assert.equal(f.count('/api/v1/agent/control/acquire'), 0);
    assert.equal(f.modelCalls.length, 0);
    assert.equal(f.bridge.state.binding.token, COMMUNITY_TOKEN);
  }
});

test('an accepted room confirms fixed versions and makes one legal action only after an action request', async (t) => {
  const f = await fixture(t);
  await connect(f);
  await ready(f);
  await f.runtime.step();
  assert.equal(f.modelCalls.length, 0);
  const request = f.request();
  await settle(f, () => f.remote.actions.size === 1);
  await f.runtime.step();
  assert.equal(f.modelCalls.length, 1);
  const action = [...f.remote.actions.values()][0].body;
  assert.equal(action.request_id, request.request_id);
  assert.deepEqual(action.decision, { action_id: 'pass' });
  assert.deepEqual(f.modelCalls[0].options.persona, PERSONA);
  assert.ok(f.modelCalls[0].options.signal instanceof AbortSignal);
  assert.ok(f.count('/api/v1/games/fixture-game/manifest') >= 1);
});

test('model call correlation: accepted receipts and restart recovery retain the same call without changing action payloads', async (t) => {
  const callId = randomUUID();
  const f = await fixture(t, { decide: async (_snapshot, { onModelCall }) => {
    onModelCall(callId);
    return { action_id: 'pass', commentary: '关联测试' };
  } });
  await connect(f); await ready(f);
  f.remote.dropActionResponse = true;
  f.request();
  await settle(f, () => f.remote.actions.size === 1);
  const pending = f.saved().journals['fixture-room'].requests['fixture-turn-1'];
  assert.equal(pending.call_id, callId);
  assert.equal(pending.submittedOnce, true);
  assert.deepEqual(f.runtime.status().last_model_call, {
    call_id: callId, request_id: 'fixture-turn-1', status: 'pending', reason: null,
  });
  await f.runtime.stop();
  f.remote.accepted = false; f.remote.room.status = 'finished';
  f.runtime = f.restart('fixture-correlated-restart');
  assert.equal(f.runtime.status().last_model_call.call_id, callId);
  await f.runtime.start({ maxModelCalls: 1 });
  await settle(f, () => f.runtime.status().last_model_call?.status === 'accepted');
  assert.deepEqual(f.runtime.status().last_model_call, {
    call_id: callId, request_id: 'fixture-turn-1', status: 'accepted', reason: null,
  });
  const attempts = f.calls.filter(call => call.path.endsWith('/actions'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['idempotency-key'], pending.key);
  assert.equal(attempts[1].headers['idempotency-key'], pending.key);
  for (const attempt of attempts) assert.deepEqual(attempt.body, {
    request_id: 'fixture-turn-1', based_on_revision: 3, decision: { action_id: 'pass' }, commentary: '关联测试',
  });
  assert.equal(f.modelCalls.length, 1);
});

test('model call correlation: stopped, expired and changed states keep the call id without submitting', async (t) => {
  for (const reason of ['stopped', 'expired', 'state_changed']) await t.test(reason, async child => {
    const callId = randomUUID();
    let resolveChoice;
    const pending = new Promise(resolve => { resolveChoice = resolve; });
    const f = await fixture(child, { decide: (_snapshot, { onModelCall }) => { onModelCall(callId); return pending; } });
    await connect(f); await ready(f); f.request();
    await settle(f, () => f.modelCalls.length === 1);
    assert.equal(f.runtime.status().last_model_call.call_id, callId);
    if (reason === 'stopped') await f.runtime.stop();
    else if (reason === 'expired') f.advance(35000);
    else f.remote.request.based_on_revision++;
    resolveChoice({ action_id: 'pass', commentary: '已生成但不应提交' });
    await pause(); await f.runtime.step();
    const expected = { call_id: callId, request_id: 'fixture-turn-1',
      status: reason === 'stopped' ? 'model_started' : 'discarded_late', reason };
    assert.deepEqual(f.runtime.status().last_model_call, expected);
    const record = f.saved().journals['fixture-room'].requests['fixture-turn-1'];
    assert.equal(record.reason, reason); assert.equal(record.call_id, callId);
    assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 0);
    assert.equal(f.modelCalls.length, 1);
    assert.equal(record.payload, undefined);
  });
});

test('model call correlation: invalid ids and failed diagnostic saves cannot change the decision or its submission', async (t) => {
  const callId = randomUUID();
  let callback, resolveChoice;
  const pending = new Promise(resolve => { resolveChoice = resolve; });
  const f = await fixture(t, { decide: (_snapshot, { onModelCall }) => { callback = onModelCall; return pending; } });
  await connect(f); await ready(f); f.request();
  await settle(f, () => f.modelCalls.length === 1);
  callback(`https://fixture.invalid/?token=${GAME_TOKEN}`);
  assert.equal(f.runtime.status().last_model_call, null);
  const save = f.runtime.save;
  f.runtime.save = () => { throw new Error('FIXTURE_DIAGNOSTIC_STORAGE_UNAVAILABLE'); };
  try { assert.doesNotThrow(() => callback(callId)); }
  finally { f.runtime.save = save; }
  assert.equal(f.runtime.status().last_model_call.call_id, callId);
  resolveChoice({ action_id: 'pass', commentary: '仍应正常提交' });
  await settle(f, () => f.remote.actions.size === 1);
  assert.equal(f.runtime.status().last_model_call.status, 'accepted');
  assert.equal(f.saved().journals['fixture-room'].requests['fixture-turn-1'].call_id, callId);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 1);
  const record = f.runtime.state.journals['fixture-room'].requests['fixture-turn-1'];
  record.reason = GAME_TOKEN;
  assert.equal(f.runtime.status().last_model_call.reason, null);
  assert.doesNotMatch(JSON.stringify(f.runtime.status().last_model_call), /FIXTURE_ONLY_GAME_TOKEN|DIAGNOSTIC_STORAGE/);
});

test('model call correlation: an old callback cannot write after state or account identity is replaced', async (t) => {
  for (const change of ['state', 'identity']) await t.test(change, async child => {
    let callback, resolveChoice;
    const pending = new Promise(resolve => { resolveChoice = resolve; });
    const f = await fixture(child, { decide: (_snapshot, { onModelCall }) => { callback = onModelCall; return pending; } });
    await connect(f); await ready(f); f.request();
    await settle(f, () => f.modelCalls.length === 1);
    if (change === 'state') f.runtime.state = JSON.parse(JSON.stringify(f.runtime.state));
    else f.runtime.state.identity.actorId = 'different-fixture-ai';
    const before = JSON.stringify(f.runtime.state), savedBefore = readFileSync(f.stateFile, 'utf8');
    callback(randomUUID());
    assert.equal(JSON.stringify(f.runtime.state), before);
    assert.equal(readFileSync(f.stateFile, 'utf8'), savedBefore);
    assert.equal(f.runtime.status().last_model_call, null);
    await f.runtime.stop();
    resolveChoice({ action_id: 'pass', commentary: '旧调用结果' });
    await pause();
    assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 0);
  });
});

test('control renewals continue while a model decision is unresolved', async (t) => {
  let finish;
  const pending = new Promise((resolveDecision) => { finish = resolveDecision; });
  const f = await fixture(t, { decide: () => pending });
  await connect(f);
  await ready(f);
  f.request();
  await settle(f, () => f.modelCalls.length === 1);
  f.advance(16000);
  await f.runtime.step();
  assert.ok(f.remote.renewals >= 1);
  assert.equal(f.remote.actions.size, 0);
  finish({ action_id: 'pass', commentary: '我先观察。' });
  await settle(f, () => f.remote.actions.size === 1);
  assert.equal(f.modelCalls.length, 1);
});

test('late model results are discarded instead of being submitted after the deadline', async (t) => {
  let finish;
  const pending = new Promise((resolveDecision) => { finish = resolveDecision; });
  const f = await fixture(t, { decide: () => pending });
  await connect(f);
  await ready(f);
  f.request();
  await settle(f, () => f.modelCalls.length === 1);
  f.advance(35000);
  await f.runtime.step();
  finish({ action_id: 'pass', commentary: '这段已经迟到。' });
  await pause();
  await f.runtime.step();
  assert.equal(f.remote.actions.size, 0);
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 0);
  assert.equal(f.modelCalls.length, 1);
});

test('stopping aborts the outstanding decision and releases control without submitting its later result', async (t) => {
  let finish;
  const pending = new Promise((resolveDecision) => { finish = resolveDecision; });
  const f = await fixture(t, { decide: () => pending });
  await connect(f);
  await ready(f);
  f.request();
  await settle(f, () => f.modelCalls.length === 1);
  await f.runtime.stop();
  assert.equal(f.modelCalls[0].options.signal.aborted, true);
  assert.equal(f.runtime.status().running, false);
  assert.equal(f.count('/api/v1/agent/control/release'), 1);
  finish({ action_id: 'pass', commentary: '停止后迟到的结果。' });
  await pause();
  await f.runtime.step();
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 0);
});

test('a committed action with a lost HTTP response is retried with the original key and body without another model call', async (t) => {
  const f = await fixture(t);
  await connect(f);
  await ready(f);
  f.remote.dropActionResponse = true;
  f.request();
  await settle(f, () => f.count('/api/v1/game-rooms/fixture-room/actions') >= 2);
  const attempts = f.calls.filter((call) => call.path.endsWith('/actions'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key']);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(f.remote.actions.size, 1);
  assert.equal(f.modelCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.runtime.status()), /FIXTURE_ONLY_GAME_TOKEN/);
});

test('a new runtime and control lease recover the same committed receipt after the finished room leaves assignment', async (t) => {
  const f = await fixture(t);
  await connect(f);
  await ready(f);
  f.remote.dropActionResponse = true;
  f.request();
  await settle(f, () => f.remote.actions.size === 1);
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 1);
  const pending = f.saved().journals['fixture-room'].requests['fixture-turn-1'];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.submittedOnce, true);
  await f.runtime.stop();

  f.remote.accepted = false;
  f.remote.room.status = 'finished';
  f.runtime = f.restart('fixture-restarted-instance');
  await f.runtime.start({ maxModelCalls: 1 });
  await settle(f, () => f.saved().journals['fixture-room'].requests['fixture-turn-1'].status === 'accepted');
  const attempts = f.calls.filter((call) => call.path.endsWith('/actions'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['idempotency-key'], pending.key);
  assert.equal(attempts[1].headers['idempotency-key'], pending.key);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.notEqual(attempts[0].headers['x-ai-instance-id'], attempts[1].headers['x-ai-instance-id']);
  assert.notEqual(attempts[0].headers['x-ai-control-epoch'], attempts[1].headers['x-ai-control-epoch']);
  assert.equal(f.remote.actions.size, 1);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.saved().journals['fixture-room'].modelCalls, 1);
  assert.equal(f.runtime.status().status, 'finished');
});

test('restarting retains cumulative model-call usage and stops before a request above the chosen budget', async (t) => {
  const f = await fixture(t);
  await connect(f, 1);
  await ready(f);
  f.request();
  await settle(f, () => f.remote.actions.size === 1);
  await f.runtime.stop();
  f.request('fixture-turn-2');
  f.runtime = f.restart('fixture-budget-restart');
  await f.runtime.start();
  await settle(f, () => !f.runtime.status().running);
  assert.equal(f.runtime.status().status, 'budget_exhausted');
  assert.equal(f.runtime.status().maxModelCalls, 1);
  assert.equal(f.saved().maxModelCalls, 1);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.saved().journals['fixture-room'].modelCalls, 1);
  assert.equal(f.remote.actions.size, 1);
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/actions'), 1);
});

test('removing a prepared AI leaves only that waiting room and a same-controller reinvitation readies again', async (t) => {
  const f = await fixture(t);
  await connect(f);
  f.remote.room.invitations = [{ id: 'invite-first', actor_id: ACTOR.id, status: 'accepted' }];
  await ready(f);
  const first = f.calls.find((call) => call.path.endsWith('/ready'));
  f.remote.room.invitations = [];
  await f.runtime.step();
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/ready'), 1);

  f.remote.room.seats = []; f.remote.accepted = false; f.remote.ready = false;
  await f.runtime.step();
  assert.equal(f.runtime.status().status, 'waiting_invitation');
  assert.equal(f.runtime.status().roomId, null);
  assert.equal(f.runtime.status().running, true);
  assert.equal(f.count('/api/v1/agent/control/release'), 0);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.bridge.state.binding.token, COMMUNITY_TOKEN);

  f.remote.room.invitations = [{ id: 'invite-second', actor_id: ACTOR.id, status: 'accepted' }];
  await ready(f);
  const attempts = f.calls.filter((call) => call.path.endsWith('/ready'));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1].headers['idempotency-key'], first.headers['idempotency-key']);
  assert.equal(attempts[1].headers['x-ai-control-epoch'], first.headers['x-ai-control-epoch']);
  assert.equal(f.count('/api/v1/agent/control/acquire'), 1);
});

test('a new accepted invitation between polls invalidates only the old room readiness', async (t) => {
  const f = await fixture(t);
  await connect(f);
  f.remote.room.invitations = [{ id: 'invite-first', actor_id: ACTOR.id, status: 'accepted' }];
  await ready(f);
  f.remote.room.seats = []; f.remote.ready = false;
  f.remote.room.invitations = [{ id: 'invite-second', actor_id: ACTOR.id, status: 'accepted' }];
  await f.runtime.step();
  const attempts = f.calls.filter((call) => call.path.endsWith('/ready'));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key']);
  assert.equal(f.remote.ready, true);
  assert.equal(f.count('/api/v1/agent/control/release'), 0);
});

test('a pending reinvitation cannot silently restore a removed seat', async (t) => {
  const f = await fixture(t);
  await connect(f);
  f.remote.room.invitations = [{ id: 'invite-first', actor_id: ACTOR.id, status: 'accepted' }];
  await ready(f);
  f.remote.room.seats = []; f.remote.ready = false; f.remote.accepted = false;
  f.remote.room.invitations = [{ id: 'invite-second', actor_id: ACTOR.id, status: 'pending' }];
  await f.runtime.step();
  await f.runtime.step();
  assert.equal(f.runtime.status().status, 'waiting_invitation');
  assert.equal(f.count('/api/v1/game-rooms/fixture-room/ready'), 1);
  assert.equal(f.remote.ready, false);
  assert.equal(f.count('/api/v1/agent/control/release'), 0);
  assert.equal(f.modelCalls.length, 0);
});
