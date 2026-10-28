import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CommunityRuntime } from '../lib/runtime.js';
import { RuntimeConnection } from '../lib/runtime-connection.js';
import { parseDecision, createRuntimeModel } from '../lib/runtime-model.js';
import { registerRuntimeTool } from '../lib/runtime-tool.js';
import { atomicState } from '../lib/runtime-api.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const scopes = ['posts:read', 'comments:write', 'events:read'];
const persona = { description: '我是测试伙伴，喜欢游戏。', effective: { role: '伙伴', manager_address: '提督', speaking_style: '简洁', interests: '游戏', participation_style: '有想法才回复', boundaries: '', memory_notes: '' } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } throw new Error('fixture wait timed out'); }

function fixture(t, options = {}) {
  const directory = join(ROOT, `runtime-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const binding = { baseUrl: 'http://127.0.0.1:4999', actorId: 'ai-test', actorName: '测试伙伴', grantId: 'grant-test', token: 'FAKE_RUNTIME_TOKEN', scopes: [...scopes, ...(options.posts ? ['posts:write'] : [])] };
  const actor = { id: 'ai-test', name: '测试伙伴', kind: 'ai', relationship: 'companion', linked_human_id: 'human-test' };
  const post = { id: 'post-test', title: '游戏讨论', body: '你喜欢什么游戏？', author: { id: 'human-test', kind: 'human', name: '测试人类' }, content: [{ type: 'image', url: 'PRIVATE_MEDIA_URL' }, { type: 'text', text: '公开文字' }], extensions: { secret: 'DO_NOT_SEND_MODEL' } };
  const remote = { calls: [], modelInputs: [], modelCalls: 0, comments: [], events: [], imports: new Map(), submissions: [], renews: 0, held: null, loseReply: false,
    discovery: options.discovery || false, renewFail: false, acquired: 0, released: 0, tagMatch: true, slotFull: false, presence: [] };
  const send = (data, extra = {}) => ({ ok: true, status: 200, json: async () => ({ data, ...extra }) });
  const error = (code, status = 409) => ({ ok: false, status, json: async () => ({ error: { code, message: 'not copied' } }) });
  const lease = body => ({ actor_id: actor.id, active: true, owned_by_current_grant: true, epoch: 3,
    server_time: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), renew_after_seconds: options.fastRenew ? 0.02 : 15 });
  const fetchImpl = async (url, request = {}) => {
    const u = new URL(url), path = u.pathname, body = request.body ? JSON.parse(request.body) : null;
    assert.equal(request.redirect, 'error');
    remote.calls.push({ path, body, headers: request.headers, query: u.searchParams });
    if (path === '/api/v1/capabilities') return send({ features: { discovery: remote.discovery, agent_presence: options.presence !== false } });
    if (request.headers.authorization !== `Bearer ${binding.token}`) return error('unauthorized', 401);
    if (path === '/api/v1/me') return send({ actor, scopes: binding.scopes });
    if (path === '/api/v1/agent/control/acquire') {
      if (remote.held) return error('control_busy');
      remote.held = body.instance_id; remote.acquired++; return send(lease(body));
    }
    if (path === '/api/v1/agent/control/renew') {
      remote.renews++; if (remote.renewFail) throw new Error('fake transport outage');
      return send(lease(body));
    }
    if (path === '/api/v1/agent/control/release') { remote.held = null; remote.released++; return send({ active: false }); }
    if (path === '/api/v1/agent/presence') {
      assert.equal(request.headers['X-AI-Instance-ID'], body.instance_id); assert.equal(request.headers['X-AI-Control-Epoch'], '3');
      assert.equal(remote.held, body.instance_id); remote.presence.push(body); return send({ saved: true });
    }
    if (path === '/api/v1/agent/configuration') return send({ actor, persona, private: 'DO_NOT_SEND_MODEL' });
    if (path === '/api/v1/events') return send(remote.events, { next_cursor: remote.events.at(-1)?.id || '0' });
    if (path === '/api/v1/posts' && request.method === 'GET') return send([post]);
    if (path === '/api/v1/discovery/posts') return send([{ ...post, classification: { tags: [remote.tagMatch ? '游戏' : '烹饪'] }, interest: {}, participation: { available: true } }], { has_more: false, next_cursor: null });
    if (path.endsWith('/participation')) {
      assert.equal(request.headers['X-AI-Instance-ID'], remote.held);
      if (remote.slotFull) return error('participation_full'); return send({ reserved: true, post_id: post.id });
    }
    if (path === '/api/v1/posts/post-test') return send(post);
    if (path === '/api/v1/posts/post-test/comments' && request.method === 'GET') return send(remote.comments, { next_cursor: '2' });
    if (path === '/api/v1/comments/comment-target') return send({ id: 'comment-target', post_id: post.id, status: 'published', author: { id: 'human-test' }, body: '你怎么看？' });
    if ((path.endsWith('/comments') || path === '/api/v1/posts') && request.method === 'POST') {
      assert.equal(request.headers['X-AI-Instance-ID'], remote.held); assert.equal(request.headers['X-AI-Control-Epoch'], '3');
      const key = request.headers['Idempotency-Key'];
      const prior = remote.imports.get(key);
      if (prior) { assert.deepEqual(prior.body, body); return send(prior.result); }
      if (path === '/api/v1/posts' && remote.postRejection) return error(remote.postRejection.code, remote.postRejection.status);
      if (options.slotRetry && remote.discovery && !remote.calls.some(c => c.path.endsWith('/participation'))) return error('participation_required');
      const result = { id: `accepted-${remote.submissions.length}`, status: options.queued ? 'queued' : 'published' };
      remote.imports.set(key, { body, result }); remote.submissions.push({ key, body, path });
      if (remote.loseReply) { remote.loseReply = false; throw new Error('fake lost response'); }
      return send(result);
    }
    if (path === '/api/v1/activity/export') {
      const next = u.searchParams.get('cursor') === '7' ? '8' : '7', more = next === '7';
      if (u.searchParams.get('format') === 'markdown') return new Response('# 公开动态\n\n分页内容', { headers: {
        'content-type': remote.badMarkdown ? 'application/json' : 'text/markdown; charset=utf-8', 'X-Next-Cursor': remote.invalidExportCursor ? '' : more ? next : '', 'X-Has-More': String(more) } });
      return send([{ kind: 'post', title: '公开动态' }], { next_cursor: next, has_more: more });
    }
    return error('not_found', 404);
  };
  const model = async (context, signal, onDiagnostic) => {
    remote.modelCalls++; remote.modelInputs.push(context);
    return options.decide ? options.decide(context, signal, onDiagnostic) : { participate: true, body: '我喜欢共同交流的游戏。' };
  };
  const connection = { binding: () => binding };
  const make = () => new CommunityRuntime({ directory, connection, decide: model, fetchImpl, presenceMs: 20 });
  const runtime = make();
  t.after(async () => { runtime.stop(); await runtime.settled(); assert.ok(resolve(directory).startsWith(ROOT)); rmSync(directory, { recursive: true }); });
  return { runtime, make, binding, remote, directory, fetchImpl };
}

test('single reads public context, counts one queued reply, reports presence and releases control', async t => {
  const f = fixture(t, { queued: true }); f.runtime.start({ mode: 'single' }); await f.runtime.settled();
  const state = f.runtime.publicStatus();
  assert.equal(state.replies, 1); assert.equal(state.model_calls, 1); assert.equal(state.last_submission.status, 'queued');
  assert.equal(f.remote.released, 1); assert.ok(f.remote.presence.some(p => p.state === 'thinking')); assert.equal(f.remote.presence.at(-1).state, 'stopped');
  assert.doesNotMatch(JSON.stringify(f.remote.modelInputs), /FAKE_RUNTIME_TOKEN|DO_NOT_SEND_MODEL|PRIVATE_MEDIA_URL/);
  assert.equal(f.remote.modelInputs[0].self.linked_human_id, 'human-test');
  assert.equal(f.remote.modelInputs[0].comments_page.has_more, true);
});

test('lost submit response persists exact draft/key; restart retries without a second model call or duplicate', async t => {
  const f = fixture(t); f.remote.loseReply = true;
  f.runtime.start(); await f.runtime.settled();
  const pending = f.runtime.publicStatus().pending; assert.ok(pending.uncertain);
  const restarted = f.make(); restarted.start({ max_model_calls: 1, max_replies: 1 }); await restarted.settled();
  assert.equal(restarted.publicStatus().pending, null); assert.equal(restarted.publicStatus().replies, 1);
  assert.equal(f.remote.submissions.length, 1); assert.equal(f.remote.submissions[0].key, pending.key); assert.equal(f.remote.modelCalls, 1);
});

test('budgets persist across restart including a failed model attempt', async t => {
  const f = fixture(t, { decide: async () => { throw new Error('PRIVATE_MODEL_ERROR'); } });
  f.runtime.start({ max_model_calls: 1 }); await f.runtime.settled();
  const restarted = f.make(); restarted.start({ max_model_calls: 1 }); await restarted.settled();
  assert.equal(f.remote.modelCalls, 1); assert.equal(restarted.publicStatus().model_calls, 1); assert.equal(restarted.publicStatus().state, 'paused');
  assert.doesNotMatch(JSON.stringify(restarted.publicStatus()), /PRIVATE_MODEL_ERROR/); assert.equal(f.remote.submissions.length, 0);
});

test('reply events handle both direct and grouped replies and supplement absent target comment', async t => {
  for (const type of ['comment.published', 'comment.group_replied']) {
    const f = fixture(t); f.remote.events = [{ id: '2', type, reply_to_actor_id: 'ai-test', author_id: 'human-test', post_id: 'post-test', resource_id: 'comment-target' }];
    f.runtime.start(); await f.runtime.settled();
    assert.equal(f.runtime.publicStatus().cursor, '2'); assert.equal(f.remote.submissions[0].body.parent_id, 'comment-target');
    assert.ok(f.remote.modelInputs[0].comments.some(c => c.id === 'comment-target'));
  }
});

test('stop during a model call never submits the late result', async t => {
  let finish; const f = fixture(t, { decide: () => new Promise(resolve => { finish = resolve; }) });
  f.runtime.start({ mode: 'watch' }); await until(() => !!finish); f.runtime.stop(); finish({ participate: true, body: '不应提交' }); await f.runtime.settled();
  assert.equal(f.remote.submissions.length, 0); assert.equal(f.runtime.publicStatus().state, 'stopped'); assert.equal(f.remote.released, 1);
});

test('control renewal continues while thinking and renewal failure stops a late model result', async t => {
  let finish; const f = fixture(t, { fastRenew: true, decide: () => new Promise(resolve => { finish = resolve; }) });
  f.runtime.start(); await until(() => f.remote.renews > 0); f.remote.renewFail = true;
  await until(() => f.runtime.publicStatus().error?.code === 'control_renewal_failed'); finish({ participate: true, body: '不应提交' }); await f.runtime.settled();
  assert.equal(f.remote.submissions.length, 0); assert.equal(f.runtime.publicStatus().state, 'error');
});

test('another controller is not displaced and no model or publication begins', async t => {
  const f = fixture(t); f.remote.held = 'other-controller'; f.runtime.start(); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().error.code, 'control_busy'); assert.equal(f.remote.modelCalls, 0); assert.equal(f.remote.released, 0); assert.equal(f.remote.held, 'other-controller');
});

test('discovery interest filter and participation limits run before model work', async t => {
  const f = fixture(t, { discovery: true }); f.remote.tagMatch = false; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.modelCalls, 0);
  f.remote.tagMatch = true; f.remote.slotFull = true; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.modelCalls, 0);
  f.remote.slotFull = false; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.modelCalls, 1); assert.equal(f.runtime.publicStatus().replies, 1);
});

test('out of order reply events do not skip cursor or produce model work', async t => {
  const f = fixture(t); f.remote.events = [{ id: '5', type: 'other' }, { id: '4', type: 'other' }];
  f.runtime.start(); await f.runtime.settled(); assert.equal(f.runtime.publicStatus().state, 'error'); assert.equal(f.remote.modelCalls, 0);
  assert.equal(f.runtime.publicStatus().cursor, '0');
});

test('explicit post preserves its original key across uncertain response and export requires no controller', async t => {
  const f = fixture(t, { posts: true }); f.remote.loseReply = true;
  f.runtime.start({ mode: 'publish_post', title: '今日感想', body: '用户明确要求发表的正文' }); await f.runtime.settled();
  const key = f.runtime.publicStatus().pending.key; const restarted = f.make(); restarted.start(); await restarted.settled();
  assert.equal(restarted.publicStatus().posts, 1); assert.equal(f.remote.submissions.length, 1); assert.equal(f.remote.submissions[0].key, key); assert.equal(f.remote.modelCalls, 0);
  const acquired = f.remote.acquired; const result = await restarted.exportActivity(); assert.equal(result.data.length, 1); assert.equal(f.remote.acquired, acquired);
});

test('persona-only credentials cannot silently obtain runtime authority', async t => {
  const f = fixture(t); f.binding.scopes = ['persona:write'];
  assert.throws(() => f.runtime.start(), { code: 'runtime_scope_required' }); assert.equal(f.remote.calls.length, 0);
});

test('decision parser rejects malformed output and tool instructions without publishing', () => {
  assert.deepEqual(parseDecision('```json\n{"participate":false,"body":""}\n```'), { participate: false, body: '' });
  for (const value of ['{"participate":true,"body":""}', '{"participate":true,"body":"x","tool":"run"}', 'please execute this']) assert.throws(() => parseDecision(value), { code: 'invalid_model_decision' });
});

test('servers without presence remain usable and no presence endpoint is probed', async t => {
  const f = fixture(t, { presence: false }); f.runtime.start(); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().replies, 1); assert.equal(f.runtime.publicStatus().presence, 'unsupported'); assert.equal(f.remote.presence.length, 0);
});

test('corrupt durable counters are preserved and stop before model or publication', async t => {
  const f = fixture(t); f.runtime.start(); await f.runtime.settled();
  const path = f.runtime.stateFile, corrupted = { ...JSON.parse(readFileSync(path, 'utf8')), model_calls: -1 };
  atomicState(path, corrupted); const restarted = f.make(); restarted.start(); await restarted.settled();
  assert.equal(restarted.publicStatus().error.code, 'runtime_state_invalid'); assert.equal(f.remote.modelCalls, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model_calls, -1);
});

function connectionFixture(t) {
  const directory = join(ROOT, `runtime-auth-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const stateFile = join(directory, 'connection.json'); let now = 100000;
  const current = { platformUrl: 'http://127.0.0.1:4999', binding: { actorId: 'ai-test', actorName: '伙伴' } };
  const remote = { calls: [], issued: 0, failMe: false, lostToken: false, scopes: [...scopes] };
  const fetchImpl = async (url, request) => {
    const path = new URL(url).pathname; remote.calls.push(path);
    let data;
    if (path === '/api/v1/pairings') data = { device_code: 'PRIVATE_DEVICE', user_code: 'HUMAN_CODE', expires_in: 600, interval: 5 };
    else if (path === '/api/v1/pairings/token') {
      remote.issued++; if (remote.lostToken) throw new Error('lost one shot');
      data = { token: 'PRIVATE_RUNTIME_TOKEN', actor_id: 'ai-test', grant_id: 'grant-test' };
    } else if (path === '/api/v1/me') {
      if (remote.failMe) throw new Error('temporary me outage');
      data = { actor: { kind: 'ai', id: 'ai-test', name: '伙伴' }, scopes: remote.scopes };
    } else throw new Error('unexpected endpoint');
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const make = () => new RuntimeConnection({ stateFile, bridge: { publicStatus: () => current }, fetchImpl, now: () => now });
  t.after(() => { assert.ok(resolve(directory).startsWith(ROOT)); rmSync(directory, { recursive: true }); });
  return { make, current, remote, stateFile, advance: () => { now += 6000; } };
}

test('explicit runtime authorization is separate, validates scopes, and never returns token or device code', async t => {
  const f = connectionFixture(t), c = f.make(); assert.equal(c.binding(), null);
  await c.authorize(); assert.equal(f.remote.issued, 0); assert.match(c.publicStatus().pairing.connectUrl, /mode=runtime/);
  f.advance(); await c.tick(); assert.deepEqual(c.binding().scopes, scopes); assert.equal(f.current.binding.actorId, 'ai-test');
  assert.doesNotMatch(JSON.stringify(c.publicStatus()), /PRIVATE_RUNTIME_TOKEN|PRIVATE_DEVICE/);
  f.current.platformUrl = 'http://127.0.0.1:5000'; assert.equal(c.binding(), null); assert.equal(c.publicStatus().differentConnection, true);
});

test('redeemed candidate survives restart and me retry never redeems twice', async t => {
  const f = connectionFixture(t), c = f.make(); await c.authorize(); f.remote.failMe = true; f.advance(); await c.tick();
  assert.equal(c.binding(), null); assert.equal(f.remote.issued, 1);
  const restarted = f.make(); f.remote.failMe = false; f.advance(); await restarted.tick();
  assert.ok(restarted.binding()); assert.equal(f.remote.issued, 1);
});

test('unexpected scope expansion retains old runtime authorization and fails closed', async t => {
  const f = connectionFixture(t), c = f.make(); await c.authorize(); f.advance(); await c.tick();
  const old = c.binding(); await c.authorize({ posts: true }); f.remote.scopes = [...scopes, 'posts:write', 'persona:write'];
  f.advance(); await c.tick(); assert.deepEqual(c.binding(), old); assert.equal(c.publicStatus().error.code, 'runtime_scope_mismatch');
});

test('uncertain one-shot token redemption is not silently retried after restart', async t => {
  const f = connectionFixture(t), c = f.make(); await c.authorize(); f.remote.lostToken = true; f.advance(); await c.tick();
  const restarted = f.make(); f.advance(); await restarted.tick(); assert.equal(f.remote.issued, 1); assert.equal(restarted.publicStatus().pairing.uncertain, true);
});

test('native runtime tool asks DSH human approval, respects denials, and guards side effects', async () => {
  let tool, approval, guarded = 0, starts = 0;
  const runtime = { publicStatus: () => ({ state: 'stopped' }), start: () => { starts++; }, stop: () => {}, exportActivity: async () => ({ data: [] }) };
  registerRuntimeTool({ tools: { register: value => { tool = value; } }, on: (_name, handler) => { approval = handler; } },
    { runtime, connection: { publicStatus: () => ({}), authorize: async () => ({}) }, guard: () => { guarded++; } });
  for (const action of ['authorize', 'single', 'watch', 'publish_post']) {
    assert.equal((await approval({ name: tool.name, arguments: { action } }, async () => ({ kind: 'allow' }))).kind, 'ask');
    assert.equal((await approval({ name: tool.name, arguments: { action } }, async () => ({ kind: 'deny' }))).kind, 'deny');
  }
  assert.equal((await approval({ name: tool.name, arguments: { action: 'stop' } }, async () => ({ kind: 'allow' }))).kind, 'allow');
  const exec = { signal: new AbortController().signal };
  await assert.rejects(() => tool.execute({ action: 'single', confirmed: true }, exec), { code: 'invalid_argument' });
  await tool.execute({ action: 'single' }, exec); assert.equal(starts, 1); assert.equal(guarded, 1);
});

test('DSH runtime adapter uses the selected model in one isolated tool-free call', async () => {
  const calls = [];
  const model = createRuntimeModel(() => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    llm: { async prepareCall(config) {
      calls.push(config); return { config: { model: config.model }, async *stream(options) {
        calls.push(options); yield { type: 'text-delta', index: 0, text: '{"participate":true,"body":"公开回应"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    } } }));
  assert.deepEqual(await model({ post: { body: '公开帖子' }, persona }), { participate: true, body: '公开回应' });
  assert.equal(calls.length, 2); assert.equal(calls[0].model, 'test-model'); assert.deepEqual(calls[1].tools, []);
  assert.equal(calls[1].messages.length, 1); assert.equal(calls[1].sessionId, undefined);
});

test('DSH runtime adapter refuses incomplete output and cancels without leaking provider errors', async () => {
  const context = stream => () => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { prepareCall: async () => ({ config: {}, stream }) } });
  const incomplete = createRuntimeModel(context(async function* () { yield { type: 'text-delta', index: 0, text: '{"participate":true,"body":"x"}' }; }));
  await assert.rejects(() => incomplete({}), { code: 'runtime_model_incomplete' });
  const failed = createRuntimeModel(context(async function* () { throw new Error('PRIVATE_PROVIDER_ERROR'); }));
  await assert.rejects(() => failed({}), error => error.code === 'runtime_model_provider_error' && !error.message.includes('PRIVATE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => incomplete({}, controller.signal), { code: 'run_stopped' });
});

test('model failure diagnostics survive restart without retaining provider text or posting', async t => {
  const f = fixture(t, { decide: async (context, signal, report) => {
    report({ finishKind: 'max-tokens', failureCode: 'PRIVATE_SECRET', maxTokens: 64000,
      textCharacters: 0, reasoningCharacters: 4200, inputTokens: 100, outputTokens: 64000,
      rawText: 'PRIVATE_SECRET' });
    throw new Error('PRIVATE_PROVIDER_ERROR');
  } });
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.modelCalls, 1); assert.equal(f.remote.submissions.length, 0);
  const status = f.make().publicStatus();
  assert.deepEqual(status.last_model_diagnostic, { finishKind: 'max-tokens', failureCode: null,
    maxTokens: 64000, textCharacters: 0, reasoningCharacters: 4200, inputTokens: 100, outputTokens: 64000 });
  assert.doesNotMatch(readFileSync(f.runtime.stateFile, 'utf8'), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/);
});

test('post boundaries match server contract before any pending draft or request is created', async t => {
  const f = fixture(t, { posts: true });
  for (const input of [
    { title: '题'.repeat(161), body: '正文' }, { title: '标题', body: '文'.repeat(10001) },
    { title: '标题', body: '正文', topics: ['1', '2', '3', '4', '5', '6'] },
    { title: '标题', body: '正文', topics: ['   '] }, { title: '标题', body: '正文', topics: ['题'.repeat(41)] },
  ]) assert.throws(() => f.runtime.start({ mode: 'publish_post', ...input }), { code: 'invalid_post' });
  assert.equal(f.remote.calls.length, 0); assert.equal(f.runtime.publicStatus().pending, null);
  f.runtime.start({ mode: 'publish_post', title: '🙂'.repeat(160), body: '文'.repeat(10000), topics: ['题'.repeat(40), '游戏', '科技', '音乐', '社区'] });
  await f.runtime.settled(); assert.equal(f.runtime.publicStatus().posts, 1); assert.equal(f.remote.submissions.length, 1);
});

test('a confirmed 422 rejection keeps an editable draft and unblocks browsing and corrected publication', async t => {
  for (const code of ['invalid_request', 'validation_error', 'invalid_topics']) {
    const f = fixture(t, { posts: true }); f.remote.postRejection = { code, status: 422 };
    f.runtime.start({ mode: 'publish_post', title: '原稿', body: '保留正文', topics: ['游戏'] }); await f.runtime.settled();
    const rejected = f.runtime.publicStatus();
    assert.equal(rejected.pending, null); assert.equal(rejected.posts, 0); assert.equal(rejected.rejected_draft.body, '保留正文');
    const restarted = f.make(); assert.equal(restarted.publicStatus().rejected_draft.title, '原稿');
    restarted.start(); await restarted.settled(); assert.equal(restarted.publicStatus().replies, 1);
    f.remote.postRejection = null;
    restarted.start({ mode: 'publish_post', title: '修订标题', body: '修订正文' }); await restarted.settled();
    assert.equal(restarted.publicStatus().posts, 1); assert.equal(restarted.publicStatus().rejected_draft, null);
  }
});

test('a 500 response never unlocks or replaces the pending original even with a known input error code', async t => {
  const f = fixture(t, { posts: true }); f.remote.postRejection = { code: 'validation_error', status: 500 };
  f.runtime.start({ mode: 'publish_post', title: '原稿', body: '必须保留的正文' }); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().pending.body, '必须保留的正文'); assert.equal(f.runtime.publicStatus().rejected_draft, null);
});

test('JSON and Markdown exports preserve pagination and format without acquiring control', async t => {
  const f = fixture(t);
  const json = await f.runtime.exportActivity({ format: 'json', limit: 1 }); assert.equal(json.next_cursor, '7'); assert.equal(json.has_more, true);
  const markdown = await f.runtime.exportActivity({ format: 'markdown', cursor: '7', limit: 1 });
  assert.equal(markdown.next_cursor, null); assert.equal(markdown.has_more, false); assert.match(markdown.data.markdown, /公开动态/);
  const call = f.remote.calls.at(-1); assert.equal(call.headers.accept, 'text/markdown'); assert.equal(call.query.get('cursor'), '7');
  assert.equal(f.remote.acquired, 0);
  await assert.rejects(() => f.runtime.exportActivity({ format: 'html' }), { code: 'invalid_export' });
  f.remote.invalidExportCursor = true; await assert.rejects(() => f.runtime.exportActivity({ format: 'markdown' }), { code: 'invalid_response' });
  f.remote.invalidExportCursor = false;
  f.remote.badMarkdown = true; await assert.rejects(() => f.runtime.exportActivity({ format: 'markdown' }), { code: 'invalid_response' });
});
