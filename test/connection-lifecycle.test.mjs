import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RegistrationBridge } from '../lib/core.js';
import { registerCompanionTool } from '../lib/companion-tool.js';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const SOUL = '我叫测试岛风，是一名秘书舰。我喜欢游戏。';
const OLD_ORIGIN = 'https://old-community.invalid';
const NEW_ORIGIN = 'https://new-community.invalid';

function fixture(t) {
  const root = join(TEST_ROOT, `connection-${randomUUID()}`);
  const memoryDir = join(root, 'memory');
  const stateFile = join(root, 'state.json');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'SOUL.md'), SOUL);
  writeFileSync(join(memoryDir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  const remotes = new Map([OLD_ORIGIN, NEW_ORIGIN].map((origin, index) => [origin, {
    origin, token: `FIXTURE_ONLY_TOKEN_${index}`, actor: { id: `fixture-ai-${index}`, kind: 'ai', name: '测试岛风' },
    approved: false, offline: false, controlBusy: false, dropImport: false, revision: 0, imports: new Map(),
  }]));
  let time = 100000;
  let normalizations = 0;
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const remote = remotes.get(url.origin);
    assert.ok(remote, `Unexpected test origin: ${url.origin}`);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    const call = { origin: url.origin, path: url.pathname, headers: { ...options.headers }, body };
    calls.push(call);
    if (remote.offline) throw new Error('Fixture network unavailable');
    const send = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    const fail = (code) => ({ ok: false, status: 409, json: async () => ({ error: { code } }) });
    if (url.pathname === '/api/v1/pairings') {
      assert.equal(call.headers.authorization, undefined);
      return send({ device_code: 'FIXTURE_DEVICE_CODE', user_code: 'FIXTURE_CODE', expires_in: 600, interval: 5 });
    }
    if (url.pathname === '/api/v1/pairings/token') {
      assert.equal(call.headers.authorization, undefined);
      return remote.approved
        ? send({ token: remote.token, actor_id: remote.actor.id, grant_id: `fixture-grant-${remote.actor.id}` })
        : fail('authorization_pending');
    }
    assert.equal(call.headers.authorization, `Bearer ${remote.token}`);
    if (url.pathname === '/api/v1/me') return send({ actor: remote.actor, scopes: ['persona:write'] });
    if (url.pathname === '/api/v1/agent/configuration') return send({ actor: remote.actor, revision: remote.revision });
    if (url.pathname === '/api/v1/agent/persona/preview') return send({ actor: remote.actor, revision: remote.revision });
    if (url.pathname === '/api/v1/agent/control/acquire') return remote.controlBusy
      ? fail('control_busy') : send({ active: true, owned_by_current_grant: true, epoch: 2 });
    if (url.pathname === '/api/v1/agent/control/release') return send({ active: false });
    if (url.pathname === '/api/v1/agent/persona/import') {
      const key = call.headers['Idempotency-Key'];
      const previous = remote.imports.get(key);
      if (previous) { assert.deepEqual(body, previous.body); return send(previous.result); }
      assert.equal(body.expected_revision, remote.revision);
      const result = { actor: remote.actor, revision: ++remote.revision };
      remote.imports.set(key, { body, result });
      if (remote.dropImport) { remote.dropImport = false; throw new Error('Fixture response lost after commit'); }
      return send(result);
    }
    assert.fail(`Unexpected test endpoint: ${url.pathname}`);
  };
  const options = { stateFile, memoryDir, baseUrl: OLD_ORIGIN, fetchImpl, now: () => time,
    normalizePersona: async ({ description }) => {
      normalizations++;
      return { name: '测试岛风', description, overrides: { role: '秘书舰' },
        normalization: { model: 'fixture-model', evidence: { name: '测试岛风', role: '秘书舰' } } };
    } };
  t.after(() => {
    const child = relative(TEST_ROOT, resolve(root));
    assert.ok(child && !child.startsWith('..') && !child.includes(':'));
    rmSync(root, { recursive: true });
  });
  return { bridge: new RegistrationBridge(options), options, remotes, calls,
    get normalizations() { return normalizations; },
    saved() { return JSON.parse(readFileSync(stateFile, 'utf8')); },
    advance() { time += 6000; },
    count(path) { return calls.filter((call) => call.path === path).length; },
  };
}

async function connect(f, origin = OLD_ORIGIN) {
  await f.bridge.configure({ enabled: true });
  f.remotes.get(origin).approved = true;
  f.advance();
  await f.bridge.tick();
}

test('same-community upgrade retains authorization without new pairing, normalization, or persona import', async (t) => {
  const f = fixture(t);
  await connect(f);
  const before = f.saved();
  const normalizations = f.normalizations;
  f.bridge = new RegistrationBridge(f.options);
  await f.bridge.tick();
  await f.bridge.configure({ enabled: true });
  await f.bridge.sync();
  assert.equal(f.saved().binding.token, before.binding.token);
  assert.equal(f.saved().binding.grantId, before.binding.grantId);
  assert.equal(f.bridge.publicStatus().status, 'bound');
  assert.equal(f.normalizations, normalizations);
  assert.equal(f.count('/api/v1/pairings'), 1);
  assert.equal(f.count('/api/v1/agent/persona/import'), 1);
});

test('preparing a different community refuses before any request and preserves the original binding', async (t) => {
  const f = fixture(t);
  await connect(f);
  const before = f.saved();
  const count = f.calls.length;
  await assert.rejects(() => f.bridge.prepare({ platformUrl: NEW_ORIGIN }), { code: 'bound_platform' });
  assert.equal(f.calls.length, count);
  assert.equal(f.saved().baseUrl, OLD_ORIGIN);
  assert.deepEqual(f.saved().binding, before.binding);
  assert.equal(f.calls.some((call) => call.origin === NEW_ORIGIN), false);
});

test('confirmed switch pauses without HTTP, preserves the reviewed persona, and only reconnects to the new community', async (t) => {
  const f = fixture(t);
  await f.bridge.prepare({ description: '我叫测试岛风，是一名秘书舰。' });
  await connect(f);
  const before = f.saved();
  const oldCallCount = f.calls.length;
  const status = await f.bridge.reconnect({ platformUrl: `${NEW_ORIGIN}/` });
  assert.equal(status.enabled, false);
  assert.equal(status.status, 'disabled');
  assert.equal(status.platformUrl, NEW_ORIGIN);
  assert.equal(status.binding, undefined);
  assert.equal(status.pairing, undefined);
  assert.equal(f.calls.length, oldCallCount);
  const cleared = f.saved();
  for (const field of ['binding', 'pair', 'pending', 'importedSourceHash']) assert.equal(cleared[field], undefined);
  for (const field of ['draft', 'normalization', 'selectedDescription', 'memoryDir']) assert.deepEqual(cleared[field], before[field]);
  assert.equal(readFileSync(join(f.options.memoryDir, 'SOUL.md'), 'utf8'), SOUL);
  f.bridge = new RegistrationBridge(f.options);
  await f.bridge.tick();
  assert.equal(f.calls.length, oldCallCount);
  await f.bridge.prepare({ platformUrl: NEW_ORIGIN });
  assert.equal(f.normalizations, 1);
  await connect(f, NEW_ORIGIN);
  const newCalls = f.calls.slice(oldCallCount);
  assert.ok(newCalls.length > 0);
  assert.ok(newCalls.every((call) => call.origin === NEW_ORIGIN));
  assert.equal(JSON.stringify(newCalls).includes(before.binding.token), false);
  assert.equal(f.bridge.publicStatus().status, 'bound');
  assert.equal(f.saved().binding.token, f.remotes.get(NEW_ORIGIN).token);
  assert.equal(f.remotes.get(NEW_ORIGIN).imports.size, 1);
});

test('an unconfirmed import cannot be discarded by switching and remains recoverable under its original key', async (t) => {
  const f = fixture(t);
  f.remotes.get(OLD_ORIGIN).dropImport = true;
  await connect(f);
  assert.equal(f.bridge.state.pending.stage, 'attempted');
  const before = f.saved();
  const count = f.calls.length;
  await assert.rejects(() => f.bridge.reconnect({ platformUrl: NEW_ORIGIN }), { code: 'pending_result_unknown' });
  assert.deepEqual(f.saved(), before);
  assert.equal(f.calls.length, count);
  await f.bridge.sync();
  assert.equal(f.bridge.publicStatus().status, 'bound');
  const imports = f.calls.filter((call) => call.path === '/api/v1/agent/persona/import');
  assert.equal(imports.length, 2);
  assert.equal(imports[0].headers['Idempotency-Key'], before.pending.key);
  assert.equal(imports[1].headers['Idempotency-Key'], before.pending.key);
  assert.equal(f.remotes.get(OLD_ORIGIN).revision, 1);
  assert.equal(f.calls.some((call) => call.origin === NEW_ORIGIN), false);
});

test('ordinary network failures retain the binding and recovery checks identity without another persona import', async (t) => {
  const f = fixture(t);
  await connect(f);
  const before = f.saved().binding;
  f.remotes.get(OLD_ORIGIN).offline = true;
  await assert.rejects(() => f.bridge.sync(), { code: 'network_error' });
  assert.deepEqual(f.saved().binding, before);
  assert.equal(f.saved().baseUrl, OLD_ORIGIN);
  f.remotes.get(OLD_ORIGIN).offline = false;
  await f.bridge.sync();
  assert.equal(f.bridge.publicStatus().status, 'bound');
  assert.equal(f.count('/api/v1/pairings'), 1);
  assert.equal(f.count('/api/v1/agent/persona/import'), 1);
  assert.deepEqual(f.saved().binding, before);
});

test('an invalid destination or aborted switch preserves the old binding', async (t) => {
  const f = fixture(t);
  await connect(f);
  const before = f.saved();
  const count = f.calls.length;
  await assert.rejects(() => f.bridge.reconnect({ platformUrl: 'https://user:password@new-community.invalid' }), { code: 'invalid_platform' });
  assert.equal(f.saved().baseUrl, before.baseUrl);
  assert.deepEqual(f.saved().binding, before.binding);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => f.bridge.reconnect({ platformUrl: NEW_ORIGIN, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.saved().baseUrl, before.baseUrl);
  assert.deepEqual(f.saved().binding, before.binding);
  assert.equal(f.calls.length, count);
});

test('a failed connection-state save preserves the old authorization and pending import in memory and on disk', async (t) => {
  const f = fixture(t);
  f.remotes.get(OLD_ORIGIN).controlBusy = true;
  await connect(f);
  assert.equal(f.bridge.state.pending.stage, 'previewed');
  const before = f.saved();
  const count = f.calls.length;
  const realSave = f.bridge.save;
  f.bridge.save = () => { throw new Error('Fixture storage unavailable'); };
  await assert.rejects(() => f.bridge.reconnect({ platformUrl: NEW_ORIGIN }), { code: 'state_save_failed' });
  assert.deepEqual(f.bridge.state, before);
  assert.deepEqual(f.saved(), before);
  assert.equal(f.bridge.publicStatus().platformUrl, OLD_ORIGIN);
  assert.equal(f.bridge.publicStatus().busy, false);
  assert.equal(f.calls.length, count);
  f.bridge.save = realSave;
  f.remotes.get(OLD_ORIGIN).controlBusy = false;
  await f.bridge.sync();
  assert.equal(f.bridge.publicStatus().status, 'bound');
  assert.equal(f.saved().binding.token, before.binding.token);
  assert.equal(f.calls.find((call) => call.path === '/api/v1/agent/persona/import').headers['Idempotency-Key'], before.pending.key);
  assert.equal(f.count('/api/v1/pairings'), 1);
  assert.equal(f.calls.some((call) => call.origin === NEW_ORIGIN), false);
});

test('companion reconnect asks through DSH with the destination and cannot be approved by a model-supplied boolean', async (t) => {
  const f = fixture(t);
  await connect(f);
  let tool, approval;
  registerCompanionTool({ tools: { register(value) { tool = value; } }, on(name, handler) {
    assert.equal(name, 'tools/pre-execute'); approval = handler;
  } }, { bridge: f.bridge, publicState: () => f.bridge.publicStatus(), discovery: () => ({ status: 'ready', memoryDir: f.options.memoryDir }) });
  const args = { action: 'reconnect', platformUrl: NEW_ORIGIN };
  const request = { name: tool.name, arguments: args };
  const ask = await approval(request, async () => ({ kind: 'allow' }));
  assert.equal(ask.kind, 'ask');
  assert.ok(JSON.stringify(ask).includes(NEW_ORIGIN));
  const denied = { kind: 'deny', reason: 'fixture policy denial' };
  assert.equal(await approval(request, async () => denied), denied);
  const priorAsk = { kind: 'ask', reason: 'fixture upstream approval' };
  assert.equal(await approval(request, async () => priorAsk), priorAsk);
  const count = f.calls.length;
  const before = f.saved();
  const exec = { signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({ ...args, confirmed: true }, exec), { code: 'invalid_argument' });
  assert.deepEqual(f.saved(), before);
  const result = await tool.execute(args, exec);
  assert.equal(result.platformUrl, NEW_ORIGIN);
  assert.equal(result.enabled, false);
  assert.equal(result.binding, undefined);
  assert.equal(f.calls.length, count);
  assert.doesNotMatch(JSON.stringify(result), /FIXTURE_ONLY_TOKEN/);
});

test('companion reconnect without an address asks for the current community and pauses without HTTP', async (t) => {
  const f = fixture(t);
  await connect(f);
  let tool, approval;
  registerCompanionTool({ tools: { register(value) { tool = value; } }, on(name, handler) {
    assert.equal(name, 'tools/pre-execute'); approval = handler;
  } }, { bridge: f.bridge, publicState: () => f.bridge.publicStatus(), discovery: () => ({ status: 'ready', memoryDir: f.options.memoryDir }) });
  const args = { action: 'reconnect' };
  const ask = await approval({ name: tool.name, arguments: args }, async () => ({ kind: 'allow' }));
  assert.equal(ask.kind, 'ask');
  assert.ok(JSON.stringify(ask).includes(OLD_ORIGIN));
  const count = f.calls.length;
  const result = await tool.execute(args, { signal: new AbortController().signal });
  assert.equal(result.platformUrl, OLD_ORIGIN);
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
  assert.equal(result.binding, undefined);
  assert.equal(f.calls.length, count);
  assert.equal(f.saved().baseUrl, OLD_ORIGIN);
});
