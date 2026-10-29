import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createServer } from 'node:http';
import { ManagementSession, validateManagementSession } from '../lib/management-session.js';
import { registerCompanionTool } from '../lib/companion-tool.js';
import { registerRuntimeTool } from '../lib/runtime-tool.js';
import { registerGameTool } from '../lib/game-tool.js';
import { apply } from '../lib/index.js';

function directory(t) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'management-session-'));
  t.after(() => { assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true }); });
  return root;
}

function host({ active = [], stored = [], archived = [], failStat = false } = {}) {
  const headers = ids => new Map(ids.map(id => [id, { id }]));
  const live = headers(active), disk = headers(stored), calls = [];
  const services = {
    sessions: { get: id => live.has(id) ? { header: live.get(id) } : undefined },
    sessionPersistence: { async stat(id) { calls.push(id); if (failStat) throw new Error('RAW_PRIVATE_ERROR'); return disk.has(id) ? { header: disk.get(id) } : undefined; } },
    workspaceRegistry: { archivedSessionIds: archived },
  };
  return { ctx: { get: name => services[name] }, calls, live, disk };
}

function registration(root, ctx, options = {}) {
  return new ManagementSession({ file: join(root, 'management-session.json'), validate: id => validateManagementSession(ctx, id), ...options });
}

const execution = id => ({ agent: { session: { id } }, signal: new AbortController().signal });

function toolSet(managementSession, { failPrepare = false } = {}) {
  const tools = new Map();
  const ctx = { on() {}, tools: { register: tool => tools.set(tool.name, tool) } };
  const state = { memoryDir: 'fixture-memory', normalization: { status: 'ready', changed: false } };
  registerCompanionTool(ctx, { managementSession,
    bridge: { publicStatus: () => state, async prepare() { if (failPrepare) throw new Error('prepare_failed'); }, async configure() {}, async sync() {}, async reconnect() {} },
    discovery: () => ({ status: 'ready', memoryDir: 'fixture-memory' }), publicState: () => ({ success: true }),
  });
  registerRuntimeTool(ctx, { managementSession,
    connection: { publicStatus: () => ({}), async authorize() { return { authorized: true }; } },
    runtime: { publicStatus: () => ({}), start: () => ({ started: true }), requestDraft: async () => ({ draft: true }), stop: () => ({ stopped: true }), exportActivity: async () => ({ items: [] }) },
  });
  registerGameTool(ctx, { status: () => ({}), start: async () => ({ started: true }), stop: async () => ({ stopped: true }) }, { managementSession });
  return tools;
}

test('management binding persists alone across restart and preserves existing credential bytes', async t => {
  const root = directory(t), { ctx, calls } = host({ stored: ['session-existing'] });
  const credentialPath = join(root, 'state.json'), credentialBytes = '{"fixture_secret":"must-not-change"}\r\n';
  writeFileSync(credentialPath, credentialBytes);
  const management = registration(root, ctx);
  assert.deepEqual(management.publicStatus(), { sessionId: null });
  await management.bind('session-existing');
  assert.deepEqual(calls, ['session-existing']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'management-session.json'), 'utf8')), { sessionId: 'session-existing' });
  assert.equal(readFileSync(credentialPath, 'utf8'), credentialBytes);
  assert.deepEqual(registration(root, ctx).publicStatus(), { sessionId: 'session-existing' });
});

test('validation rejects invalid, missing, archived and hidden subagent targets without reading chat', async t => {
  const root = directory(t), h = host({ active: ['session-active', 'session-child'], archived: ['session-archived'] });
  h.live.set('session-child', { id: 'session-child', origin: 'subagent' });
  const management = registration(root, h.ctx);
  for (const [id, code] of [[null, 'invalid'], ['../secret', 'invalid'], ['session-missing', 'not_found'], ['session-archived', 'archived'], ['session-child', 'invalid']]) {
    await assert.rejects(management.bind(id), e => e.code === `management_session_${code}`);
  }
  assert.deepEqual(management.publicStatus(), { sessionId: null });
  assert.equal(existsSync(join(root, 'management-session.json')), false);
  await management.bind('session-active');
  assert.deepEqual(h.calls, ['session-missing']);
});

test('host read failure is sanitized and never writes an arbitrary id', async t => {
  const root = directory(t), h = host({ failStat: true });
  const management = registration(root, h.ctx);
  await assert.rejects(management.bind('session-any'), e => e.code === 'management_session_unavailable' && !e.message.includes('RAW_PRIVATE'));
  assert.equal(existsSync(join(root, 'management-session.json')), false);
});

test('read-only and stop actions never bind; first successful substantive action stays bound across other chats', async t => {
  const root = directory(t), h = host({ active: ['session-first', 'session-second'] });
  const management = registration(root, h.ctx), tools = toolSet(management);
  for (const [name, action] of [['tangui_companion', 'status'], ['tangui_community', 'status'], ['tangui_community', 'stop'], ['tangui_community', 'export_activity'], ['tangui_game', 'status'], ['tangui_game', 'stop']]) {
    await tools.get(name).execute({ action }, execution('session-second'));
  }
  assert.deepEqual(management.publicStatus(), { sessionId: null });
  await tools.get('tangui_companion').execute({ action: 'prepare' }, execution('session-first'));
  for (const [name, action] of [['tangui_companion', 'prepare'], ['tangui_community', 'authorize'], ['tangui_community', 'single'], ['tangui_community', 'watch'], ['tangui_community', 'publish_post'], ['tangui_game', 'start']]) {
    await tools.get(name).execute({ action }, execution('session-second'));
  }
  assert.equal(management.publicStatus().sessionId, 'session-first');
  h.live.delete('session-first');
  await tools.get('tangui_community').execute({ action: 'single' }, execution('session-second'));
  assert.equal(management.publicStatus().sessionId, 'session-first');
  await management.bind('session-second');
  assert.equal(management.publicStatus().sessionId, 'session-second');
});

test('all three tool forms capture their own first successful substantive action', async t => {
  for (const [name, action] of [['tangui_companion', 'connect'], ['tangui_community', 'authorize'], ['tangui_game', 'start']]) {
    const root = directory(t), { ctx } = host({ active: ['session-owner'] });
    const management = registration(root, ctx);
    await toolSet(management).get(name).execute({ action }, execution('session-owner'));
    assert.equal(management.publicStatus().sessionId, 'session-owner');
  }
});

test('failed substantive work and missing executor never change management binding', async t => {
  const root = directory(t), { ctx } = host({ active: ['session-owner'] });
  const management = registration(root, ctx);
  await assert.rejects(toolSet(management, { failPrepare: true }).get('tangui_companion').execute({ action: 'prepare' }, execution('session-owner')));
  await toolSet(management).get('tangui_community').execute({ action: 'single' }, { signal: new AbortController().signal });
  assert.equal(management.publicStatus().sessionId, null);
});

test('storage failure and unexpected notification error cannot change successful tool outcomes', async t => {
  const root = directory(t), { ctx } = host({ active: ['session-owner'] });
  const management = registration(root, ctx, { save() { throw new Error('PRIVATE_DISK_PATH'); } });
  for (const [name, action] of [['tangui_companion', 'prepare'], ['tangui_community', 'single'], ['tangui_game', 'start']]) {
    const result = await toolSet(management).get(name).execute({ action }, execution('session-owner'));
    assert.ok(result);
    await toolSet({ capture() { throw new Error('unexpected'); } }).get(name).execute({ action }, execution('session-owner'));
  }
  assert.deepEqual(management.publicStatus(), { sessionId: null, storageError: true });
  await assert.rejects(management.bind('session-owner'), e => e.code === 'management_session_save_failed' && !e.message.includes('PRIVATE_DISK'));
});

test('simultaneous first captures serialize and malformed saved state is retained', async t => {
  const root = directory(t), { ctx } = host({ stored: ['session-first', 'session-second'] });
  const management = registration(root, ctx);
  await Promise.all([management.capture(execution('session-first')), management.capture(execution('session-second'))]);
  assert.equal(management.publicStatus().sessionId, 'session-first');
  const damaged = '{invalid', path = join(root, 'damaged.json'); writeFileSync(path, damaged);
  const broken = registration(root, ctx, { file: path });
  await broken.capture(execution('session-second'));
  assert.deepEqual(broken.publicStatus(), { sessionId: null, storageError: true });
  assert.equal(readFileSync(path, 'utf8'), damaged);
});

test('management route inherits host authentication and origin protection; validates and returns safe binding', async t => {
  const root = directory(t), stateFile = join(root, 'state.json'), h = host({ stored: ['session-first', 'session-second'] });
  const disposers = [], nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https://api.github.com/repos/bzny/dsh-plugin-tangui/') ?
    Promise.resolve(new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v0.4.2' }))) : nativeFetch(url, options);
  let route, origin;
  const server = createServer((req, res) => route(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const effect = setup => disposers.push(setup());
  const web = { effect,
    connection: { requestRejection: req => req.headers['x-fixture-session'] === 'yes' ? undefined : 401 },
    webServer: { getOrigin: () => origin, register(config) { route = config.handler; return () => {}; } },
  };
  apply({ ...h.ctx, effect, inject(names, callback) { if (names.includes('webServer')) callback(web); } }, { stateFile, memoryDir: '', platformUrl: '' });
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose?.();
    await new Promise(done => server.close(done)); globalThis.fetch = nativeFetch;
  });
  const endpoint = `${origin}/api/tangui/registration`;
  const request = (body, headers = {}) => nativeFetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-tangui-client': '1', 'x-fixture-session': 'yes', origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({ action: 'management_bind', sessionId: 'session-first' }, { 'x-fixture-session': '' })).status, 401);
  assert.equal((await request({ action: 'management_bind', sessionId: 'session-first' }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request({ action: 'management_bind', sessionId: '../unknown' })).status, 400);
  assert.equal((await request({ action: 'management_bind', sessionId: 'session-missing' })).status, 404);
  assert.equal((await request({ action: 'management_bind', sessionId: 'session-first', token: 'not-accepted' })).status, 400);
  for (const id of ['session-first', 'session-second']) {
    const response = await request({ action: 'management_bind', sessionId: id });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).managementSession, { sessionId: id });
  }
  const response = await nativeFetch(endpoint, { headers: { 'x-fixture-session': 'yes' } });
  assert.deepEqual((await response.json()).managementSession, { sessionId: 'session-second' });
  assert.equal(existsSync(stateFile), false);
});

