import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RegistrationBridge, readSoul, platformUrl } from '../lib/core.js';
import plugin, { Config, apply } from '../lib/index.js';
import { registerCompanionTool } from '../lib/companion-tool.js';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const SOUL = '# SOUL\n\n## 身份\n- **名字**：测试岛风\n- **角色**：秘书舰\n\n## 性格特质\n- 活泼、细心\n\n## 沟通风格\n- **语言**：中文\n\n## 边界\n- 未授权不发帖\n';

async function fixture(t, { complete = true, soul = SOUL, normalizer } = {}) {
  const root = join(TEST_ROOT, randomUUID());
  const memoryDir = join(root, 'memory');
  mkdirSync(join(memoryDir, 'user'), { recursive: true });
  writeFileSync(join(memoryDir, 'SOUL.md'), soul);
  writeFileSync(join(memoryDir, 'BOOTSTRAP.md'), `---\nstatus: ${complete ? 'complete' : 'pending'}\n---\n`);
  writeFileSync(join(memoryDir, 'user', 'profile.md'), 'PRIVATE_USER_PROFILE_MUST_NOT_UPLOAD');
  writeFileSync(join(memoryDir, 'log.md'), 'PRIVATE_LOG_MUST_NOT_UPLOAD');
  let time = 100000;
  const calls = [];
  const normalizationCalls = [];
  const deterministicNormalizer = async ({ description }) => {
    const name = description.includes('只公开名字') ? '只公开名字' : '测试岛风';
    const role = description.includes('秘书舰') ? '秘书舰' : '助手';
    return { name, description, overrides: { role }, normalization: { model: 'fixture-model', evidence: { name, role } } };
  };
  const remote = { approved: false, busy: false, dropToken: false, dropImport: false, revision: 0, actor: { id: 'ai-fixture-1', kind: 'ai', name: '平台已存在岛风' }, imports: new Map() };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    calls.push({ path, body, headers: req.headers });
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
    const fail = (code, status = 409) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: 'not echoed' } })); };
    if (path === '/api/v1/pairings') return send({ device_code: 'FAKE_DEVICE_CODE_FOR_TEST_ONLY', user_code: 'ABC01234', expires_in: 600, interval: 5 }, 201);
    if (path === '/api/v1/pairings/token') {
      if (!remote.approved) return fail('authorization_pending');
      if (remote.dropToken) { req.socket.destroy(); return; }
      return send({ token: 'FAKE_PLUGIN_TOKEN_FOR_TEST_ONLY', grant_id: 'grant-test', actor_id: remote.actor.id });
    }
    if (req.headers.authorization !== 'Bearer FAKE_PLUGIN_TOKEN_FOR_TEST_ONLY') return fail('unauthorized', 401);
    if (path === '/api/v1/me') return send({ actor: remote.actor, scopes: ['persona:write'] });
    if (path === '/api/v1/agent/configuration') return send({ actor: remote.actor, revision: remote.revision });
    if (path === '/api/v1/agent/persona/preview') {
      if (body.expected_revision !== remote.revision) return fail('configuration_conflict');
      return send({ actor: remote.actor, revision: remote.revision });
    }
    if (path === '/api/v1/agent/control/acquire') {
      if (remote.busy) return fail('control_busy');
      return send({ active: true, owned_by_current_grant: true, epoch: 4 });
    }
    if (path === '/api/v1/agent/control/release') return send({ active: false, epoch: 5 });
    if (path === '/api/v1/agent/persona/import') {
      assert.equal(req.headers['x-ai-control-epoch'], '4');
      assert.match(req.headers['x-ai-instance-id'], /^[a-f0-9-]{36}$/);
      const key = req.headers['idempotency-key'];
      const previous = remote.imports.get(key);
      if (previous) { assert.deepEqual(previous.body, body); return send(previous.result); }
      if (body.expected_revision !== remote.revision) return fail('configuration_conflict');
      const result = { actor: remote.actor, revision: ++remote.revision };
      remote.imports.set(key, { body, result });
      if (remote.dropImport) { remote.dropImport = false; req.socket.destroy(); return; }
      return send(result);
    }
    fail('not_found', 404);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { stateFile: join(root, 'state', 'state.json'), memoryDir, baseUrl, now: () => time, timeoutMs: 1500,
    normalizePersona: async (input) => { normalizationCalls.push(input); return (normalizer || deterministicNormalizer)(input); } };
  t.after(async () => {
    await new Promise((done) => server.close(done));
    assert.ok(resolve(root).startsWith(`${TEST_ROOT}\\`) || resolve(root).startsWith(`${TEST_ROOT}/`));
    rmSync(root, { recursive: true });
  });
  return { bridge: new RegistrationBridge(options), options, remote, calls, memoryDir, normalizationCalls,
    advance() { time += 6000; }, count(path) { return calls.filter((call) => call.path.endsWith(path)).length; } };
}

async function connect(f) {
  await f.bridge.configure({ enabled: true });
  f.remote.approved = true; f.advance(); await f.bridge.tick();
}

test('disabled by default; completion gates pairing; two files only; exact identity and private import', async (t) => {
  const f = await fixture(t, { complete: false });
  await f.bridge.tick();
  assert.equal(f.calls.length, 0);
  await f.bridge.configure({ enabled: true });
  assert.equal(f.calls.length, 0);
  assert.equal(f.normalizationCalls.length, 0);
  writeFileSync(join(f.memoryDir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  await f.bridge.tick();
  assert.equal(f.count('/pairings'), 1);
  f.advance(); await f.bridge.tick();
  assert.equal(f.bridge.publicStatus().status, 'awaiting_approval');
  f.remote.approved = true; f.advance(); await f.bridge.tick();
  const state = f.bridge.publicStatus();
  assert.equal(state.status, 'bound');
  assert.equal(state.binding.actorId, f.remote.actor.id);
  assert.equal(state.binding.actorName, f.remote.actor.name);
  assert.equal(state.binding.revision, 1);
  assert.equal(f.count('/control/release'), 1);
  assert.equal(f.count('/actors'), 0);
  assert.equal(f.count('/posts'), 0);
  assert.doesNotMatch(JSON.stringify(state), /FAKE_PLUGIN_TOKEN|FAKE_DEVICE_CODE/);
  const upload = f.calls.find((call) => call.path.endsWith('/persona/import')).body;
  assert.equal(upload.description, SOUL);
  assert.equal(upload.overrides.role, '秘书舰');
  assert.doesNotMatch(JSON.stringify(upload), /PRIVATE_USER_PROFILE|PRIVATE_LOG/);
});

test('restart and status check do not repeat pairings/import; local edits need explicit update', async (t) => {
  const f = await fixture(t); await connect(f);
  const restart = new RegistrationBridge(f.options); await restart.tick(); await restart.sync();
  assert.notEqual(restart.state.instanceId, f.bridge.state.instanceId);
  assert.equal(f.count('/pairings'), 1); assert.equal(f.count('/persona/import'), 1);
  writeFileSync(join(f.memoryDir, 'SOUL.md'), `${SOUL}\n## 兴趣\n麻将\n`);
  await restart.tick();
  assert.equal(restart.publicStatus().changed, true); assert.equal(f.count('/persona/import'), 1);
  await restart.prepare();
  await restart.sync({ fresh: true });
  assert.equal(f.count('/persona/import'), 2); assert.equal(restart.publicStatus().changed, false);
});

test('busy controller is never preempted and retry keeps original request', async (t) => {
  const f = await fixture(t); f.remote.busy = true; await connect(f);
  assert.equal(f.bridge.publicStatus().status, 'control_busy');
  assert.equal(f.count('/persona/import'), 0); assert.equal(f.count('/control/release'), 0);
  const key = f.bridge.state.pending.key;
  f.remote.busy = false; await f.bridge.sync();
  assert.equal(f.calls.find((call) => call.path.endsWith('/persona/import')).headers['idempotency-key'], key);
  assert.equal(f.bridge.publicStatus().status, 'bound');
});

test('lost import response reuses body and key without re-previewing obsolete revision', async (t) => {
  const f = await fixture(t); f.remote.dropImport = true; await connect(f);
  assert.equal(f.bridge.publicStatus().status, 'error');
  assert.equal(f.bridge.state.pending.stage, 'attempted');
  assert.equal(f.remote.revision, 1);
  const originalKey = f.bridge.state.pending.key;
  await assert.rejects(() => f.bridge.sync({ fresh: true }), { code: 'pending_result_unknown' });
  assert.equal(f.bridge.state.pending.key, originalKey);
  await f.bridge.sync();
  assert.equal(f.remote.revision, 1); assert.equal(f.count('/persona/preview'), 1);
  assert.equal(f.bridge.publicStatus().binding.revision, 1);
  const imports = f.calls.filter((call) => call.path.endsWith('/persona/import'));
  assert.equal(imports[0].headers['idempotency-key'], imports[1].headers['idempotency-key']);
});

test('restart resumes a saved import and enabling cannot report unsynced binding as completed', async (t) => {
  const f = await fixture(t); f.remote.busy = true; await connect(f);
  const originalKey = f.bridge.state.pending.key;
  await f.bridge.configure({ enabled: false });
  await f.bridge.configure({ enabled: true });
  assert.notEqual(f.bridge.publicStatus().status, 'bound');
  f.remote.busy = false;
  const restart = new RegistrationBridge(f.options); await restart.tick();
  assert.equal(restart.publicStatus().status, 'bound');
  assert.equal(f.count('/pairings'), 1);
  assert.equal(f.calls.find((call) => call.path.endsWith('/persona/import')).headers['idempotency-key'], originalKey);
});

test('explicit mutual address is extracted without reading user profile', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.memoryDir, 'SOUL.md'), `${SOUL}\n## 与你的关系\n- **相互称呼**：我叫用户「提督」，用户叫我「岛风酱」\n`);
  assert.equal(readSoul(f.memoryDir).draft.overrides.manager_address, '提督');
});

test('lost token response stops polling and restart requires explicit reconnection', async (t) => {
  const f = await fixture(t); f.remote.dropToken = true; await connect(f);
  assert.equal(f.bridge.publicStatus().status, 'reconnect_required');
  const restart = new RegistrationBridge(f.options); f.advance(); await restart.tick();
  assert.equal(f.count('/pairings/token'), 1); assert.equal(restart.publicStatus().binding, undefined);
  assert.equal(f.count('/persona/import'), 0);
});

test('edited upload retains only reviewed text; endpoint change cannot leak stored authorization', async (t) => {
  const f = await fixture(t);
  const description = '我叫只公开名字，是一个助手。';
  await f.bridge.configure({ enabled: true, draft: { name: 'UI 伪造名字不能绕过 AI', description, overrides: { role: '伪造角色' } } });
  f.remote.approved = true; f.advance(); await f.bridge.tick();
  assert.equal(f.calls.find((call) => call.path.endsWith('/persona/import')).body.description, description);
  assert.deepEqual(f.normalizationCalls, [{ description }]);
  assert.equal(f.bridge.publicStatus().draft.name, '只公开名字');
  await assert.rejects(() => f.bridge.configure({ enabled: true, platformUrl: 'http://127.0.0.1:9999' }), { code: 'bound_platform' });
  assert.throws(() => platformUrl('http://example.com'), { code: 'invalid_platform' });
  assert.equal(readSoul(f.memoryDir).draft.name, '测试岛风');
  assert.equal(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).binding.actorId, f.remote.actor.id);
});

test('DSH Config exports and route authentication protect both data and error bodies', async (t) => {
  assert.equal(plugin.Config, Config);
  const f = await fixture(t);
  let handler;
  const disposers = [];
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const webCtx = {
    connection: { requestRejection(req) { return req.headers.cookie === 'dsh-test-cookie=authorized' ? undefined : 401; } },
    webServer: { getOrigin() { return origin; }, register(route) { handler = route.handler; return () => {}; } },
    effect(setup) { disposers.push(setup()); },
  };
  apply({ effect(setup) { disposers.push(setup()); }, inject(names, callback) { if (names[0] === 'tools') return;
    assert.deepEqual(names, ['webServer', 'connection']); callback(webCtx); } },
    Config({ memoryDir: f.options.memoryDir, stateFile: f.options.stateFile, platformUrl: f.options.baseUrl }));
  t.after(async () => { for (const stop of disposers) stop(); await new Promise((done) => server.close(done)); });
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${origin}/api/tangui/registration`, { method });
    const body = await response.text();
    assert.equal(response.status, 401); assert.doesNotMatch(body, /SOUL|测试岛风|draft|state/);
  }
  const response = await fetch(`${origin}/api/tangui/registration`, { headers: { cookie: 'dsh-test-cookie=authorized' } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.draft.description, SOUL);
  assert.equal(state.normalization.status, 'unprepared');
  assert.equal(f.calls.length, 0);
});

test('free prose is normalized before first pairing without requiring labeled fields', async (t) => {
  const prose = '我是测试岛风，一名活泼的秘书舰，会细心陪伴你。';
  const f = await fixture(t, { soul: prose });
  assert.equal(readSoul(f.memoryDir).draft.name, '');
  await connect(f);
  assert.equal(f.bridge.publicStatus().status, 'bound');
  assert.equal(f.bridge.publicStatus().draft.name, '测试岛风');
  assert.equal(f.bridge.publicStatus().normalization.status, 'ready');
  assert.equal(f.bridge.publicStatus().normalization.model, 'fixture-model');
  assert.equal(f.bridge.publicStatus().normalization.evidence.role, '秘书舰');
  assert.deepEqual(f.normalizationCalls, [{ description: prose }]);
  assert.equal(f.calls.find((call) => call.path.endsWith('/persona/import')).body.description, prose);
});

test('normalization failure stops before registration and does not retry on ticks or restart', async (t) => {
  const f = await fixture(t, { normalizer: async () => {
    const error = new Error('SECRET_FROM_MODEL_MUST_NOT_ESCAPE');
    error.diagnostic = { textChars: 42, reasoningChars: 500, wholeJsonFence: false, finishKind: 'stop',
      raw: 'SECRET_FROM_MODEL_MUST_NOT_ESCAPE', textBlocks: 'SECRET_FROM_MODEL_MUST_NOT_ESCAPE' };
    throw error;
  } });
  await assert.rejects(() => f.bridge.configure({ enabled: true }), { code: 'normalization_failed' });
  assert.equal(f.calls.length, 0);
  await f.bridge.tick(); await f.bridge.tick();
  const restarted = new RegistrationBridge(f.options); await restarted.tick();
  assert.equal(f.normalizationCalls.length, 1);
  assert.equal(restarted.publicStatus().normalization.status, 'error');
  assert.doesNotMatch(JSON.stringify(f.bridge.publicStatus()), /SECRET_FROM_MODEL/);
  assert.deepEqual(f.bridge.state.normalization.diagnostic, { textChars: 42, reasoningChars: 500, wholeJsonFence: false, finishKind: 'stop' });
  assert.doesNotMatch(JSON.stringify(f.bridge.state.normalization), /SECRET_FROM_MODEL/);
});

test('unsupported normalized claims are rejected instead of replacing evidence with defaults', async (t) => {
  const f = await fixture(t, { normalizer: async ({ description }) => ({ name: '测试岛风', description,
    overrides: { role: '秘书舰' }, normalization: { model: 'fixture-model', evidence: { name: '测试岛风', role: '原文没有这句话' } } }) });
  await assert.rejects(() => f.bridge.configure({ enabled: true }), { code: 'normalization_evidence_invalid' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.bridge.publicStatus().normalization.status, 'error');
});

test('prepare caches across restart and never registers or exposes persisted account credentials', async (t) => {
  const f = await fixture(t);
  const first = await f.bridge.prepare();
  assert.equal(first.enabled, false); assert.equal(first.normalization.status, 'ready');
  assert.equal(f.calls.length, 0); assert.equal(f.normalizationCalls.length, 1);
  const restart = new RegistrationBridge(f.options);
  await restart.prepare();
  assert.equal(f.normalizationCalls.length, 1);
  await restart.configure({ enabled: true });
  assert.equal(f.normalizationCalls.length, 1);
  f.remote.approved = true; f.advance(); await restart.tick();
  const before = JSON.parse(readFileSync(f.options.stateFile, 'utf8')).binding.token;
  const count = f.calls.length;
  await restart.prepare();
  const after = JSON.parse(readFileSync(f.options.stateFile, 'utf8')).binding.token;
  assert.equal(before, after);
  assert.equal(f.calls.length, count);
  assert.doesNotMatch(JSON.stringify(restart.publicStatus()), /FAKE_PLUGIN_TOKEN|FAKE_DEVICE_CODE/);
});

test('source edits while a model is in flight discard the old result; identical prepare is single flight', async (t) => {
  let finish;
  const f = await fixture(t, { normalizer: ({ description }) => new Promise((resolve) => {
    finish = () => resolve({ name: '测试岛风', description, overrides: { role: '秘书舰' },
      normalization: { model: 'fixture-model', evidence: { name: '测试岛风', role: '秘书舰' } } });
  }) });
  const first = f.bridge.prepare();
  const same = f.bridge.prepare();
  const firstRejected = assert.rejects(first, { code: 'normalization_stale' });
  const sameRejected = assert.rejects(same, { code: 'normalization_stale' });
  writeFileSync(join(f.memoryDir, 'SOUL.md'), `${SOUL}\n新增的真实人设内容。`);
  finish();
  await Promise.all([firstRejected, sameRejected]);
  assert.equal(f.normalizationCalls.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.bridge.publicStatus().normalization.status, 'error');
  assert.equal(f.bridge.publicStatus().draft.name, '');
});

test('edited input during preparation invalidates the running result without a second concurrent call', async (t) => {
  let finish;
  const f = await fixture(t, { normalizer: ({ description }) => new Promise((resolve) => {
    finish = () => resolve({ name: '测试岛风', description, overrides: { role: '秘书舰' },
      normalization: { model: 'fixture-model', evidence: { name: '测试岛风', role: '秘书舰' } } });
  }) });
  const first = f.bridge.prepare();
  const rejected = assert.rejects(first, { code: 'normalization_stale' });
  await assert.rejects(() => f.bridge.prepare({ description: '我叫只公开名字，是一个助手。' }), { code: 'normalization_changed_while_running' });
  finish(); await rejected;
  assert.equal(f.normalizationCalls.length, 1);
  assert.equal(f.calls.length, 0);
});

test('shortened input survives source edits and only changed source or input invokes normalization again', async (t) => {
  const f = await fixture(t);
  const description = '我叫只公开名字，是一个助手。';
  await f.bridge.prepare({ description }); await f.bridge.prepare({ description });
  assert.equal(f.normalizationCalls.length, 1);
  writeFileSync(join(f.memoryDir, 'SOUL.md'), `${SOUL}\n不允许传给模型的新增私密说明。`);
  await f.bridge.prepare();
  assert.equal(f.normalizationCalls.length, 2);
  assert.deepEqual(f.normalizationCalls, [{ description }, { description }]);
  await f.bridge.prepare({ description: `${description}我喜欢读书。` });
  assert.equal(f.normalizationCalls.length, 3);
});

test('upgrading a bound state does not normalize, upload, replace its token or create another grant', async (t) => {
  const f = await fixture(t); await connect(f);
  const state = JSON.parse(readFileSync(f.options.stateFile, 'utf8'));
  delete state.normalization;
  writeFileSync(f.options.stateFile, JSON.stringify(state));
  const restart = new RegistrationBridge(f.options);
  await restart.tick(); await restart.configure({ enabled: true });
  assert.equal(f.normalizationCalls.length, 1);
  assert.equal(f.count('/pairings'), 1); assert.equal(f.count('/persona/import'), 1);
  assert.equal(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).binding.token, state.binding.token);
  assert.doesNotMatch(JSON.stringify(restart.publicStatus()), /FAKE_PLUGIN_TOKEN|FAKE_DEVICE_CODE/);
});

test('unknown import recovery retains its key and skips normalization; new preparation is refused', async (t) => {
  const f = await fixture(t); f.remote.dropImport = true; await connect(f);
  const key = f.bridge.state.pending.key;
  await assert.rejects(() => f.bridge.prepare(), { code: 'pending_result_unknown' });
  await assert.rejects(() => f.bridge.configure({ enabled: true, memoryDir: join(f.memoryDir, 'different-source') }), { code: 'pending_result_unknown' });
  await assert.rejects(() => f.bridge.sync({ draft: f.bridge.publicStatus().draft }), { code: 'pending_result_unknown' });
  const restart = new RegistrationBridge(f.options); await restart.tick();
  assert.equal(f.normalizationCalls.length, 1);
  assert.equal(restart.publicStatus().status, 'bound');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/persona/import')).at(-1).headers['idempotency-key'], key);
  assert.equal(f.remote.revision, 1);
});

test('a missing normalizer stops first connect; an empty portable source can be configured without model work', async (t) => {
  const f = await fixture(t);
  const missing = new RegistrationBridge({ ...f.options, normalizePersona: undefined });
  await assert.rejects(() => missing.configure({ enabled: true }), { code: 'normalizer_unavailable' });
  assert.equal(f.calls.length, 0);
  const portable = new RegistrationBridge({ ...f.options, stateFile: join(f.memoryDir, 'portable-state.json'), memoryDir: '' });
  assert.equal(portable.publicStatus().sourceComplete, false);
  await portable.configure({ enabled: false, memoryDir: f.memoryDir });
  assert.equal(portable.publicStatus().memoryDir, f.memoryDir);
  assert.equal(f.normalizationCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test('changing memory directories cannot reuse the former companions shortened draft', async (t) => {
  const f = await fixture(t);
  const oldShortened = '我叫只公开名字，是一个助手。';
  await f.bridge.prepare({ description: oldShortened });
  const nextDirectory = join(f.memoryDir, 'another-companion');
  mkdirSync(nextDirectory);
  const nextDescription = '我是另一个测试岛风，也是一名秘书舰。';
  writeFileSync(join(nextDirectory, 'SOUL.md'), nextDescription);
  writeFileSync(join(nextDirectory, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  await f.bridge.prepare({ memoryDir: nextDirectory });
  assert.equal(f.normalizationCalls.at(-1).description, nextDescription);
  assert.equal(f.bridge.publicStatus().draft.description, nextDescription);
  await f.bridge.configure({ enabled: false, memoryDir: f.memoryDir });
  assert.equal(f.bridge.publicStatus().normalization.status, 'unprepared');
  await f.bridge.prepare();
  assert.equal(f.normalizationCalls.at(-1).description, SOUL);
  assert.equal(f.calls.length, 0);
});

test('unfinished soul without an edited description waits and normalizes the completed latest text', async (t) => {
  const template = '# SOUL\n名字：（铸魂对话中确认）\n角色：（铸魂对话中确认）\n';
  const f = await fixture(t, { complete: false, soul: template });
  await f.bridge.configure({ enabled: true });
  assert.equal(f.bridge.publicStatus().status, 'waiting_soul');
  assert.equal(f.bridge.state.selectedDescription, undefined);
  assert.equal(f.normalizationCalls.length, 0);
  const completed = '我是测试岛风，一名活泼的秘书舰。现在铸魂完成了。';
  writeFileSync(join(f.memoryDir, 'SOUL.md'), completed);
  writeFileSync(join(f.memoryDir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  await f.bridge.tick();
  assert.deepEqual(f.normalizationCalls, [{ description: completed }]);
  assert.equal(f.count('/pairings'), 1);
  assert.equal(f.bridge.publicStatus().draft.description, completed);
});

test('unfinished soul with an explicit description requires review after completion and never freezes a template', async (t) => {
  const template = '# SOUL\n名字：（铸魂对话中确认）\n角色：（铸魂对话中确认）\n';
  const f = await fixture(t, { complete: false, soul: template });
  for (const description of [template, '用户目前只愿意提交这段删减说明。']) {
    await assert.rejects(() => f.bridge.configure({ enabled: true, description }), { code: 'soul_incomplete' });
    assert.equal(f.bridge.state.selectedDescription, undefined);
    assert.equal(f.bridge.publicStatus().enabled, false);
  }
  writeFileSync(join(f.memoryDir, 'SOUL.md'), SOUL);
  writeFileSync(join(f.memoryDir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  await f.bridge.tick();
  assert.equal(f.normalizationCalls.length, 0);
  assert.equal(f.calls.length, 0);
  const reviewed = '我叫只公开名字，是一个助手。';
  await f.bridge.configure({ enabled: true, description: reviewed });
  assert.deepEqual(f.normalizationCalls, [{ description: reviewed }]);
  assert.equal(f.count('/pairings'), 1);
});

test('community origins accept remote HTTPS and local HTTP but reject credential-bearing or ambiguous URLs', () => {
  assert.equal(platformUrl('https://community.example/'), 'https://community.example');
  assert.equal(platformUrl('http://127.0.0.1:4180'), 'http://127.0.0.1:4180');
  assert.equal(platformUrl('http://[::1]:4180/'), 'http://[::1]:4180');
  for (const value of ['http://community.example', 'http://192.168.1.5:4180', 'https://u:p@community.example',
    'https://community.example/path', 'https://community.example/?token=x', 'https://community.example/#fragment', 'ftp://community.example', '']) {
    assert.throws(() => platformUrl(value), { code: 'invalid_platform' });
  }
});

test('a fresh installation requires an explicit community address and preserves existing bindings on upgrade', async (t) => {
  const f = await fixture(t);
  const fresh = new RegistrationBridge({ ...f.options, stateFile: join(f.memoryDir, 'fresh-state.json'), baseUrl: '' });
  assert.equal(fresh.publicStatus().platformUrl, '');
  await fresh.configure({ enabled: false, memoryDir: f.memoryDir });
  await assert.rejects(() => fresh.prepare(), { code: 'invalid_platform' });
  assert.equal(f.calls.length, 0);
  await connect(f);
  const existing = new RegistrationBridge({ ...f.options, baseUrl: '' });
  assert.equal(existing.publicStatus().platformUrl, f.options.baseUrl);
  assert.equal(existing.publicStatus().binding.actorId, f.remote.actor.id);
  await assert.rejects(() => existing.prepare({ platformUrl: 'https://other.example' }), { code: 'bound_platform' });
});

test('a platform redirect cannot forward the bearer or reach another endpoint', async (t) => {
  const f = await fixture(t);
  let redirectedRequests = 0;
  const destination = createServer((_req, res) => { redirectedRequests++; res.end('{}'); });
  await new Promise((done) => destination.listen(0, '127.0.0.1', done));
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/collect` }); res.end();
  });
  await new Promise((done) => redirect.listen(0, '127.0.0.1', done));
  t.after(async () => { await Promise.all([destination, redirect].map((server) => new Promise((done) => server.close(done)))); });
  const bridge = new RegistrationBridge({ ...f.options, baseUrl: `http://127.0.0.1:${redirect.address().port}` });
  await assert.rejects(() => bridge.request('/api/v1/me', { token: 'FIXTURE_ONLY' }), { code: 'network_error' });
  assert.equal(redirectedRequests, 0);
  await assert.rejects(() => bridge.request('//other.example', { token: 'FIXTURE_ONLY' }), { code: 'invalid_endpoint' });
});

test('unknown upstream errors cannot echo credential material through error codes or messages', async (t) => {
  const f = await fixture(t);
  const bridge = new RegistrationBridge({ ...f.options, fetchImpl: async () => ({ ok: false, status: 500,
    json: async () => ({ error: { code: 'FIXTURE_SECRET_MUST_NOT_ESCAPE', message: 'FIXTURE_SECRET_MUST_NOT_ESCAPE' } }) }) });
  await assert.rejects(() => bridge.request('/api/v1/me', { token: 'FIXTURE_SECRET_MUST_NOT_ESCAPE' }), (error) => {
    assert.equal(error.code, 'platform_error'); assert.doesNotMatch(error.message, /FIXTURE_SECRET/); return true;
  });
});

test('native companion tool prepares, requires DSH approval for mutations, and exposes no stored credentials', async (t) => {
  const f = await fixture(t);
  let tool, approval;
  registerCompanionTool({ tools: { register(value) { tool = value; } }, on(name, handler) {
    assert.equal(name, 'tools/pre-execute'); approval = handler;
  } }, { bridge: f.bridge, publicState: () => f.bridge.publicStatus(), discovery: () => ({ status: 'ready', memoryDir: f.memoryDir }) });
  const exec = { signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({ action: 'connect' }, exec), { code: 'prepare_required' });
  await assert.rejects(() => tool.execute({ action: 'connect', confirmed: true }, exec), { code: 'invalid_argument' });
  await tool.execute({ action: 'prepare' }, exec);
  assert.equal(f.calls.length, 0);
  assert.equal(f.bridge.publicStatus().normalization.status, 'ready');
  const decision = await approval({ name: tool.name, arguments: { action: 'connect' } }, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask');
  const denied = { kind: 'deny', reason: 'fixture denial' };
  assert.equal(await approval({ name: tool.name, arguments: { action: 'connect' } }, async () => denied), denied);
  assert.deepEqual(await approval({ name: tool.name, arguments: { action: 'status' } }, async () => ({ kind: 'allow' })), { kind: 'allow' });
  const pending = await tool.execute({ action: 'connect' }, exec);
  assert.ok(pending.pairing.connectUrl.startsWith(f.options.baseUrl));
  assert.equal(f.count('/persona/import'), 0);
  f.remote.approved = true; f.advance(); await f.bridge.tick();
  const state = await tool.execute({ action: 'status' }, exec);
  assert.equal(state.status, 'bound');
  assert.doesNotMatch(JSON.stringify(state), /FAKE_PLUGIN_TOKEN|FAKE_DEVICE_CODE/);
  await assert.rejects(() => tool.execute({ action: 'connect' }, exec), { code: 'already_bound' });
  assert.equal(f.count('/pairings'), 1);
  writeFileSync(join(f.memoryDir, 'SOUL.md'), `${SOUL}\n新增人设。`);
  await assert.rejects(() => tool.execute({ action: 'sync' }, exec), { code: 'prepare_required' });
  assert.equal(f.count('/persona/import'), 1);
});
