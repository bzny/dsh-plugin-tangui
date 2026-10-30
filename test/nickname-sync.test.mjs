import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistrationBridge } from '../lib/core.js';
import { RuntimeConnection } from '../lib/runtime-connection.js';
import { CommunityRuntime, publicDiscussion } from '../lib/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const fields = ['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'];
const persona = { description: '原有人设不变', effective: Object.fromEntries(fields.map(key => [key, '原设定'])) };

function fixture(t) {
  mkdirSync(ROOT, { recursive: true }); const root = mkdtempSync(join(ROOT, 'nickname-'));
  const memoryDir = join(root, 'memory'); mkdirSync(memoryDir);
  writeFileSync(join(memoryDir, 'SOUL.md'), '我叫旧名字，是测试伙伴。');
  writeFileSync(join(memoryDir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n');
  const stateFile = join(root, 'state.json');
  let time = 100000;
  const remote = { actor: { id: 'ai-fixture', kind: 'ai', name: '新昵称' }, calls: [], offline: false, wait: null };
  const fetchImpl = async (url, options) => {
    remote.calls.push({ path: new URL(url).pathname, method: options.method });
    if (remote.wait) await remote.wait;
    if (remote.offline) throw new Error('fixture offline');
    return { ok: true, status: 200, json: async () => ({ data: { actor: { ...remote.actor } } }) };
  };
  const bridge = new RegistrationBridge({ stateFile, memoryDir, baseUrl: 'http://127.0.0.1:4999', fetchImpl });
  bridge.state.binding = { actorId: 'ai-fixture', actorName: '旧名字', token: 'FAKE_PERSONA_ONLY', grantId: 'persona-fixture', revision: 7 };
  bridge.state.draft = { name: '旧名字', description: '原有人设不变', overrides: {} };
  bridge.save();
  const connection = new RuntimeConnection({ bridge, stateFile: join(root, 'runtime-connection.json'), fetchImpl, now: () => time });
  connection.state.binding = { baseUrl: bridge.state.baseUrl, actorId: 'ai-fixture', actorName: '旧名字', grantId: 'runtime-fixture', token: 'FAKE_RUNTIME_ONLY', scopes: ['posts:read', 'comments:write', 'events:read'] };
  connection.save();
  const before = [stateFile, join(root, 'runtime-connection.json'), join(memoryDir, 'SOUL.md'), join(memoryDir, 'BOOTSTRAP.md')].map(path => [path, readFileSync(path, 'utf8')]);
  t.after(() => { assert.ok(resolve(root).startsWith(ROOT + sep)); rmSync(root, { recursive: true }); });
  return { root, bridge, connection, remote, advance: () => { time += 30001; }, unchangedFiles: () => before.forEach(([path, value]) => assert.equal(readFileSync(path, 'utf8'), value)) };
}

test('settings refresh updates only public nickname caches and reuses the existing binding', async t => {
  const f = fixture(t), original = { ...f.connection.binding() };
  await f.connection.refreshIdentity();
  assert.equal(f.bridge.publicStatus().binding.actorName, '新昵称');
  assert.equal(f.connection.publicStatus().binding.actorName, '新昵称');
  assert.equal(f.connection.publicStatus().identityRefresh.status, 'synced');
  assert.deepEqual({ ...f.connection.binding(), actorName: original.actorName }, original);
  assert.equal(f.bridge.state.draft.name, '旧名字');
  assert.equal(f.bridge.state.binding.revision, 7);
  await f.connection.refreshIdentity();
  assert.deepEqual(f.remote.calls.map(row => row.path), ['/api/v1/me']);
  f.unchangedFiles();
});

test('failed or mismatched identity refresh retains the last nickname without claiming fresh success', async t => {
  const f = fixture(t); await f.connection.refreshIdentity();
  const checkedAt = f.connection.publicStatus().identityRefresh.checkedAt;
  f.advance(); f.remote.offline = true; await f.connection.refreshIdentity();
  assert.equal(f.connection.publicStatus().binding.actorName, '新昵称');
  assert.deepEqual(f.connection.publicStatus().identityRefresh, { status: 'unconfirmed', checkedAt });
  await f.connection.refreshIdentity(); assert.equal(f.remote.calls.length, 2);
  f.advance(); f.remote.offline = false; f.remote.actor.id = 'different-ai'; await f.connection.refreshIdentity();
  assert.equal(f.bridge.publicStatus().binding.actorName, '新昵称');
  assert.equal(f.connection.publicStatus().identityRefresh.status, 'unconfirmed');
  f.unchangedFiles();
});

test('an in-flight nickname read cannot replace a switched binding or newer configuration name', async t => {
  const f = fixture(t); let resume;
  f.remote.wait = new Promise(done => { resume = done; });
  const read = f.connection.refreshIdentity();
  const otherRead = f.connection.refreshIdentity();
  assert.equal(f.remote.calls.length, 1);
  f.connection.observeActor({ id: 'ai-fixture', kind: 'ai', name: '刚从配置确认的新名' }, f.connection.binding());
  resume(); await Promise.all([read, otherRead]);
  assert.equal(f.connection.publicStatus().binding.actorName, '刚从配置确认的新名');
  f.advance(); f.remote.wait = new Promise(done => { resume = done; });
  const next = f.connection.refreshIdentity();
  f.bridge.state.baseUrl = 'https://other-community.invalid';
  f.bridge.state.binding = { actorId: 'other-ai', actorName: '另一个伙伴', token: 'FAKE_OTHER', grantId: 'other-grant' };
  resume(); await next;
  assert.equal(f.bridge.publicStatus().binding.actorName, '另一个伙伴');
  assert.equal(f.connection.publicStatus().identityRefresh.status, 'unknown');
  f.unchangedFiles();
});

test('an existing configuration read refreshes model self and shared game identity without replacing persona', async t => {
  const f = fixture(t);
  const runtime = new CommunityRuntime({ directory: join(f.root, 'runtime'), connection: f.connection, decide: async () => assert.fail('no model calls') });
  runtime.currentBinding = f.connection.binding(); runtime.actor = { id: 'ai-fixture', kind: 'ai', name: '旧名字' };
  const gameActor = runtime.actor;
  let calls = 0;
  runtime.get = async path => { assert.equal(path, '/api/v1/agent/configuration'); calls++; return { data: { actor: { ...f.remote.actor }, persona: structuredClone(persona) } }; };
  // Mirrors argument evaluation in decideOn: the actor is obtained before the awaited configuration.
  const input = publicDiscussion({ id: 'post-fixture', body: '公开内容', author: { id: 'human-fixture' } }, [], runtime.actor, null, null, await runtime.configuration());
  assert.equal(input.self.name, '新昵称');
  assert.equal(gameActor.name, '新昵称'); assert.equal(gameActor, runtime.actor);
  assert.deepEqual(input.persona, persona); assert.equal(calls, 1); assert.equal(f.remote.calls.length, 0);
  f.unchangedFiles();
});
