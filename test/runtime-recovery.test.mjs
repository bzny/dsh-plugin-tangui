import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CommunityRuntime } from '../lib/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const reply = { participate: true, body: '一起玩游戏，也一起交流。' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (data, extra = {}) => ({ ok: true, status: 200, json: async () => ({ data, ...extra }) });
const rejected = (code, status = 409) => ({ ok: false, status, json: async () => ({ error: { code, message: 'fixture rejection' } }) });
async function bounded(promise, milliseconds = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, message = 'fixture condition was not reached') {
  const end = performance.now() + 2000;
  while (performance.now() < end) { if (check()) return; await pause(5); }
  throw new Error(message);
}

function fixture(t, options = {}) {
  const directory = join(ROOT, `recovery-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const actor = { id: 'ai-test', name: '测试伙伴', kind: 'ai', relationship: 'companion', linked_human_id: 'human-test' };
  const binding = { baseUrl: 'http://127.0.0.1:4999', actorId: actor.id, actorName: actor.name, grantId: 'grant-test', token: 'FAKE_RECOVERY_TOKEN', scopes: ['posts:read', 'comments:write', 'events:read'] };
  const persona = { description: '我是测试伙伴，喜欢游戏。', effective: { role: '伙伴', manager_address: '提督', speaking_style: '简洁', interests: '游戏', participation_style: '有想法才回复', boundaries: '', memory_notes: '' } };
  const post = { id: 'post-test', title: '游戏讨论', body: '你喜欢什么游戏？', author: { id: 'human-test', kind: 'human', name: '测试人类' }, content: [] };
  let offset = 0;
  const origin = performance.now(), now = () => performance.now() - origin + offset;
  const timestamp = value => new Date(Date.UTC(2026, 0, 1) + value).toISOString();
  const control = { epoch: 0, instance: null, grant: null, expires: 0 };
  const ttl = options.ttl ?? 60000;
  const remote = { calls: [], acquired: [], renewed: [], released: [], modelCalls: 0, accepted: [], submissions: [], imports: new Map(), violations: [], faults: [], afterAccept: null,
    advance: value => { offset += value; },
    failNext: (path, fault = 'transport', count = 1, method = null) => { remote.faults.push({ path, fault, count, method }); },
    replaceController: (active = true) => { control.epoch++; control.instance = active ? 'other-instance' : null; control.grant = active ? 'other-grant' : null; control.expires = active ? now() + ttl : 0; } };
  const isActive = () => control.instance !== null && now() < control.expires;
  const snapshot = () => ({ actor_id: actor.id, epoch: control.epoch, active: isActive(), owned_by_current_grant: isActive() && control.grant === binding.grantId,
    server_time: timestamp(now()), expires_at: timestamp(control.expires), renew_after_seconds: options.renewSeconds ?? 15 });
  remote.control = control; remote.snapshot = snapshot;
  const owns = body => isActive() && control.grant === binding.grantId && control.instance === body.instance_id && control.epoch === body.epoch;
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname, body = request.body === undefined ? null : JSON.parse(request.body);
    const call = { path, method: request.method, body, headers: request.headers };
    remote.calls.push(call);
    if (request.headers.authorization !== `Bearer ${binding.token}`) return rejected('unauthorized', 401);
    const fault = remote.faults.find(item => item.count > 0 && item.path === path && (!item.method || item.method === request.method));
    if (fault) {
      fault.count--;
      if (typeof fault.fault === 'function') return fault.fault(call);
      if (fault.fault === 'transport') throw new TypeError('simulated connection reset');
      if ([502, 503, 504].includes(fault.fault)) return { ok: false, status: fault.fault, json: async () => { throw new SyntaxError('gateway returned HTML'); } };
      return rejected('fixture_failure', fault.fault);
    }
    if (path === '/api/v1/me') return send({ actor, scopes: binding.scopes });
    if (path === '/api/v1/capabilities') return send({ features: { discovery: false, agent_presence: false, control_recovery: options.controlRecovery !== false } });
    // Natural expiry changes active status only, not the epoch. Management,
    // successful acquisition after expiry, and release each advance it.
    if (path === '/api/v1/agent/control') return send(snapshot());
    if (path === '/api/v1/agent/control/acquire') {
      if (body.expected_epoch !== undefined && body.expected_epoch !== control.epoch) return rejected('control_changed');
      if (isActive() && (control.instance !== body.instance_id || control.grant !== binding.grantId)) return rejected('control_busy');
      if (!isActive()) control.epoch++;
      control.instance = body.instance_id; control.grant = binding.grantId; control.expires = now() + ttl;
      remote.acquired.push({ ...body, epoch: control.epoch });
      const result = send(snapshot());
      if (remote.loseAcquireResponse) { remote.loseAcquireResponse = false; throw new TypeError('accepted acquisition response lost'); }
      return result;
    }
    if (path === '/api/v1/agent/control/renew') {
      if (!owns(body)) return rejected('control_lost');
      control.expires = now() + ttl; remote.renewed.push({ ...body }); return send(snapshot());
    }
    if (path === '/api/v1/agent/control/release') {
      if (!owns(body)) return rejected('control_lost');
      control.epoch++; control.instance = null; control.grant = null; control.expires = 0;
      remote.released.push({ ...body }); return send(snapshot());
    }
    if (path === '/api/v1/agent/preferences') return rejected('not_found', 404);
    if (path === '/api/v1/agent/configuration') return send({ actor, persona });
    if (path === '/api/v1/events') return send([], { next_cursor: '0' });
    if (path === '/api/v1/posts') return send([post]);
    if (path === '/api/v1/posts/post-test') return send(post);
    if (path === '/api/v1/posts/post-test/comments' && request.method === 'GET') return send([], { next_cursor: null });
    if (path === '/api/v1/posts/post-test/comments' && request.method === 'POST') {
      const proof = { instance_id: request.headers['X-AI-Instance-ID'], epoch: Number(request.headers['X-AI-Control-Epoch']) };
      if (!owns(proof)) { remote.violations.push('submission without current control'); return rejected('control_lost'); }
      const key = request.headers['Idempotency-Key'];
      remote.submissions.push({ key, body, epoch: proof.epoch });
      const prior = remote.imports.get(key);
      if (prior) {
        if (JSON.stringify(body) !== JSON.stringify(prior.body)) { remote.violations.push('idempotency body changed'); return rejected('idempotency_conflict'); }
        return send(prior.result);
      }
      const result = { id: `accepted-${remote.accepted.length + 1}`, status: 'published' };
      remote.imports.set(key, { body, result }); remote.accepted.push({ key, body, result });
      if (remote.afterAccept) return remote.afterAccept(result);
      return send(result);
    }
    // A fixture typo must be an application rejection, not a transport retry.
    return rejected('not_found', 404);
  };
  const runtime = new CommunityRuntime({ directory, connection: { binding: () => binding }, fetchImpl, now,
    reconnectDelays: options.reconnectDelays ?? [5, 10],
    decide: async (...args) => { remote.modelCalls++; return options.decide ? options.decide(...args) : reply; } });
  t.after(async () => {
    runtime.stop(); options.finishModel?.(); await bounded(runtime.settled());
    assert.deepEqual(remote.violations, []);
    assert.ok(resolve(directory).startsWith(`${ROOT}${sep}`));
    rmSync(directory, { recursive: true });
  });
  const start = mode => runtime.start({ mode: mode || 'watch', max_model_calls: 10, max_replies: 1, interval_seconds: 3 });
  return { runtime, remote, start };
}

test('watch recovers a brief GET transport outage and keeps the same active epoch', async t => {
  const f = fixture(t); f.remote.failNext('/api/v1/events', 'transport');
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().replies, 1);
  assert.equal(f.remote.modelCalls, 1);
  assert.deepEqual(f.remote.acquired.map(item => item.epoch), [1, 1]);
  assert.equal(f.remote.acquired[1].expected_epoch, 1);
  assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/events').length, 2);
  assert.equal(f.remote.control.epoch, 2, 'release advances the epoch after recovery');
});

test('watch retries a lost accepted response with the identical key and body without regenerating', async t => {
  const f = fixture(t);
  f.remote.afterAccept = () => { f.remote.afterAccept = null; throw new TypeError('accepted response lost'); };
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.remote.accepted.length, 1); assert.equal(f.remote.submissions.length, 2);
  assert.equal(f.remote.submissions[0].key, f.remote.submissions[1].key);
  assert.deepEqual(f.remote.submissions[0].body, f.remote.submissions[1].body);
  assert.equal(f.runtime.publicStatus().replies, 1); assert.equal(f.runtime.publicStatus().pending, null);
});

test('renewal outage across TTL recovers while the original model call remains pending', async t => {
  let finish;
  const f = fixture(t, { ttl: 120, renewSeconds: 0.03,
    decide: () => new Promise(resolve => { finish = resolve; }), finishModel: () => finish?.(reply) });
  f.start(); await until(() => f.remote.modelCalls === 1);
  const originalInstance = f.remote.control.instance;
  f.remote.failNext('/api/v1/agent/control/renew', () => { f.remote.advance(200); throw new TypeError('renewal connection reset'); });
  await until(() => f.remote.acquired.length === 2 && !f.runtime.recoveryTask, 'expired lease was not reacquired');
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.remote.accepted.length, 0);
  assert.deepEqual(f.remote.acquired.map(item => item.epoch), [1, 2]);
  assert.equal(f.remote.acquired[1].expected_epoch, 1); assert.equal(f.remote.control.instance, originalInstance);
  finish(reply); await bounded(f.runtime.settled());
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.remote.accepted.length, 1);
  assert.equal(f.remote.submissions[0].epoch, 2); assert.equal(f.runtime.publicStatus().replies, 1);
});

for (const active of [false, true]) {
  test(`recovery refuses ${active ? 'another controller takeover' : 'a manager epoch change with no active controller'}`, async t => {
    const f = fixture(t);
    f.remote.failNext('/api/v1/events', () => { f.remote.replaceController(active); throw new TypeError('connection reset during management change'); });
    f.start(); await bounded(f.runtime.settled());
    assert.equal(f.runtime.publicStatus().error?.code, 'control_changed'); assert.equal(f.runtime.publicStatus().state, 'error');
    assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.modelCalls, 0); assert.equal(f.remote.accepted.length, 0);
    assert.equal(f.remote.control.instance, active ? 'other-instance' : null);
  });
}

test('expected_epoch rejects a management change between inspection and reacquisition', async t => {
  const f = fixture(t);
  f.remote.failNext('/api/v1/events', () => {
    f.remote.failNext('/api/v1/agent/control', () => { const prior = f.remote.snapshot(); f.remote.replaceController(false); return send(prior); });
    throw new TypeError('connection reset');
  });
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().error?.code, 'control_changed');
  const attempts = f.remote.calls.filter(call => call.path === '/api/v1/agent/control/acquire');
  assert.equal(attempts.length, 2); assert.equal(attempts[1].body.expected_epoch, 1);
  assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.accepted.length, 0);
});

test('user stop interrupts a long reconnect backoff promptly', async t => {
  const f = fixture(t, { reconnectDelays: [1000] }); f.remote.failNext('/api/v1/events', 'transport', 10);
  f.start(); await until(() => f.runtime.publicStatus().state === 'reconnecting');
  const started = performance.now(); f.runtime.stop(); await bounded(f.runtime.settled(), 500);
  assert.ok(performance.now() - started < 500);
  assert.equal(f.runtime.publicStatus().state, 'stopped'); assert.equal(f.runtime.publicStatus().detail, 'user_stopped');
  assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/me').length, 1);
  assert.equal(f.remote.modelCalls, 0); assert.equal(f.remote.accepted.length, 0);
});

test('model failures never enter community recovery or retry the model', async t => {
  const f = fixture(t, { decide: async () => { throw Object.assign(new Error('private model transport failure'), { community_transport: true, code: 'network_error' }); } });
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.runtime.publicStatus().model_calls, 1);
  assert.equal(f.runtime.publicStatus().state, 'error'); assert.equal(f.remote.accepted.length, 0);
  assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/me').length, 1);
  assert.doesNotMatch(JSON.stringify(f.runtime.publicStatus()), /private model transport failure/);
});

test('watch recovers an initial connection failure before acquiring control', async t => {
  const f = fixture(t); f.remote.failNext('/api/v1/me', 'transport');
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.acquired[0].epoch, 1);
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.runtime.publicStatus().replies, 1);
  assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/me').length, 3);
});

test('an unconfirmed first acquire stops instead of reacquiring without a known epoch', async t => {
  const f = fixture(t); f.remote.loseAcquireResponse = true;
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().error?.code, 'network_error');
  f.remote.replaceController(false);
  await pause(25);
  assert.equal(f.remote.acquired.length, 1);
  assert.equal(f.remote.control.instance, null);
  assert.equal(f.remote.modelCalls, 0);
});

for (const status of [502, 503, 504]) {
  test(`watch recovers HTTP ${status} without retrying model work`, async t => {
    const f = fixture(t); f.remote.failNext('/api/v1/events', status);
    f.start(); await bounded(f.runtime.settled());
    assert.equal(f.runtime.publicStatus().replies, 1); assert.equal(f.remote.modelCalls, 1);
    assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/events').length, 2);
  });
}

for (const status of [401, 403, 409, 429, 500]) {
  test(`watch does not automatically retry application HTTP ${status}`, async t => {
    const f = fixture(t); f.remote.failNext('/api/v1/events', status);
    f.start(); await bounded(f.runtime.settled());
    assert.equal(f.runtime.publicStatus().state, 'error'); assert.equal(f.remote.modelCalls, 0);
    assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/events').length, 1);
    assert.equal(f.remote.acquired.length, 1);
  });
}

test('structured application rejection with HTTP 503 does not trigger transport recovery', async t => {
  const f = fixture(t); f.remote.failNext('/api/v1/events', () => rejected('preferences_unavailable', 503));
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().error?.code, 'preferences_unavailable');
  assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/events').length, 1);
  assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.modelCalls, 0);
});

test('single run preserves its existing no-auto-recovery behavior', async t => {
  const f = fixture(t); f.remote.failNext('/api/v1/events', 'transport');
  f.start('single'); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().error?.code, 'network_error'); assert.equal(f.remote.modelCalls, 0);
  assert.equal(f.remote.calls.filter(call => call.path === '/api/v1/events').length, 1); assert.equal(f.remote.acquired.length, 1);
});

test('game mode also recovers initial transport failures without community reply generation', async t => {
  const f = fixture(t); f.remote.failNext('/api/v1/me', 'transport');
  f.start('game'); await until(() => f.runtime.publicStatus().detail === 'waiting');
  f.runtime.stop(); await bounded(f.runtime.settled());
  assert.equal(f.remote.acquired.length, 1); assert.equal(f.remote.modelCalls, 0); assert.equal(f.remote.accepted.length, 0);
  assert.equal(f.runtime.publicStatus().state, 'stopped');
});

test('uncertain recovery acquisition confirms its own new epoch without stealing another instance', async t => {
  const f = fixture(t);
  f.remote.failNext('/api/v1/events', () => {
    f.remote.advance(61000); f.remote.loseAcquireResponse = true; throw new TypeError('initial connection reset');
  });
  f.start(); await bounded(f.runtime.settled());
  assert.deepEqual(f.remote.acquired.map(item => item.epoch), [1, 2, 2]);
  assert.equal(new Set(f.remote.acquired.map(item => item.instance_id)).size, 1);
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.runtime.publicStatus().replies, 1);
});

test('natural expiry on a server without recovery capability stops instead of reacquiring', async t => {
  const f = fixture(t, { controlRecovery: false });
  f.remote.failNext('/api/v1/events', () => { f.remote.advance(61000); throw new TypeError('connection reset'); });
  f.start(); await bounded(f.runtime.settled());
  assert.equal(f.runtime.publicStatus().error?.code, 'control_lost'); assert.equal(f.remote.acquired.length, 1);
  assert.equal(f.remote.modelCalls, 0); assert.equal(f.remote.accepted.length, 0);
});
