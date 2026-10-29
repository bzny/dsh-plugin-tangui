import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';
import { normalizePostDraft, parseDraftDecision, serviceProactiveDraft, flushDraftRequest, createInterestSearch, publicDraftNotice, publicWebUrl } from '../lib/proactive-drafts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
function fixture() {
  let now = Date.UTC(2026, 9, 29, 10);
  const remote = { drafts: [], calls: [], model: [], searches: [], lost: false };
  const r = { mode: 'watch', state: { model_calls: 0 }, preferences: { community: { auto_post: true, draft_interval_hours: 3, draft_daily_limit: 2 }, diary: {} },
    actor: { id: 'ai-fixture' }, limits: { max_model_calls: 10 }, abort: new AbortController(),
    binding: () => ({ baseUrl: 'https://community.example' }), wallNow: () => now, isHostIdle: () => true,
    commit(patch) { this.state = { ...this.state, ...patch }; }, checkActive() { this.abort.signal.throwIfAborted(); },
    budget() { assert.ok(this.state.model_calls < 10); }, phaseTo() {}, noteModelCall() {}, async refreshPreferences() {},
    async configuration() { return { description: 'PRIVATE_MEMORY_MUST_NOT_TRAVEL', effective: { role: '伙伴', speaking_style: '活泼', memory_notes: 'PRIVATE_MEMORY_MUST_NOT_TRAVEL' } }; },
    async get() { return { data: [{ id: '10', type: 'post.published', created_at: new Date(now).toISOString(), resource: { id: 'post-fixture', author: { id: 'ai-fixture' }, title: '欢乐游戏', body: '今天逆风翻盘了。', private: 'PRIVATE_EXTRA_MUST_NOT_TRAVEL' } }] }; },
    async draftModel(context) { remote.model.push(context); return { propose: true, title: '有趣的一局', body: '我们聊到了逆风翻盘，快乐就在过程里。', topics: ['游戏'], note: '想分享游戏感想' }; },
    async searchWeb(query) { remote.searches.push(query); return [{ url: 'https://example.com/game', title: '新玩法', snippet: '适合一起玩的小游戏', date: '2026-10-29' }]; },
    api: { async data() { return { drafts: remote.drafts }; } },
    async write(path, payload, key) {
      remote.calls.push({ path, payload, key });
      let draft = remote.drafts.find(d => d.key === key);
      if (!draft) { draft = { id: `draft-${remote.drafts.length}`, key, status: 'pending', content: payload }; remote.drafts.push(draft); }
      if (remote.lost) { remote.lost = false; throw Object.assign(new Error('transport'), { code: 'network_error' }); }
      return draft;
    },
  };
  return { r, remote, advance(ms = 3 * 3600000) { now += ms; } };
}

test('manual draft rejects obvious private information locally and preserves public source references', () => {
  assert.throws(() => normalizePostDraft({ title: '联络我', body: '私人邮箱 somebody@example.com' }), { code: 'draft_privacy_review' });
  assert.throws(() => normalizePostDraft({ title: '密码', body: 'api_key=sk_123456789012345' }), { code: 'draft_privacy_review' });
  assert.equal(publicWebUrl('https://127.0.0.1/admin'), null);
  assert.equal(publicWebUrl('https://example.com/?token=private'), null);
  const draft = normalizePostDraft({ title: ' 游戏 ', body: ' 我和朋友们共同玩了一局 ', source: { kind: 'manager_requested' } });
  assert.equal(draft.initiation, 'requested'); assert.equal(draft.title, '游戏');
  assert.throws(() => parseDraftDecision('{"propose":false,"title":"x","body":"","topics":[],"note":""}'));
});

test('idle schedule starts without model, uses public whitelisted input once and blocks new pending proposals', async () => {
  const { r, remote, advance } = fixture();
  assert.equal(await serviceProactiveDraft(r), false); assert.equal(remote.model.length, 0);
  advance(); assert.equal(await serviceProactiveDraft(r), true);
  assert.equal(remote.model.length, 1); assert.equal(r.state.model_calls, 1);
  assert.doesNotMatch(JSON.stringify(remote.model), /PRIVATE_/);
  assert.equal(remote.calls[0].path, '/api/v1/agent/post-drafts');
  assert.equal(r.state.draft_notices[0].review_url, 'https://community.example/messages?draft=draft-0#post-drafts');
  advance(); await serviceProactiveDraft(r); assert.equal(remote.model.length, 1);
});

test('no input, paused, busy host, quiet hours and exhausted budget avoid generation', async () => {
  for (const patch of [{ paused: true }, { quiet_now: true }, { auto_post: false }]) {
    const { r, remote, advance } = fixture(); await serviceProactiveDraft(r); advance(); Object.assign(r.preferences.community, patch);
    await serviceProactiveDraft(r); assert.equal(remote.model.length, 0);
  }
  const { r, remote, advance } = fixture(); await serviceProactiveDraft(r); advance(); r.isHostIdle = () => false;
  await serviceProactiveDraft(r); assert.equal(remote.model.length, 0);
  r.isHostIdle = () => true; r.get = async () => ({ data: [] }); await serviceProactiveDraft(r); assert.equal(remote.model.length, 0);
});

test('same materials and rejected topic are not regenerated; rolling daily quota is not reset by restart', async () => {
  const { r, remote, advance } = fixture(); await serviceProactiveDraft(r); advance(); await serviceProactiveDraft(r);
  remote.drafts[0].status = 'rejected'; advance(); await serviceProactiveDraft(r); assert.equal(remote.model.length, 1);
  r.state.draft_schedule.proposals = [r.wallNow() - 5000, r.wallNow() - 2000]; advance();
  r.get = async () => { throw new Error('quota should stop before sources'); };
  await serviceProactiveDraft(r); assert.equal(remote.model.length, 1);
});

test('lost draft response reuses saved payload/key with no model regeneration', async () => {
  const { r, remote } = fixture();
  r.state.draft_request = { key: 'request-fixture-123', payload: normalizePostDraft({ title: '分享', body: '一起游戏很开心' }) };
  remote.lost = true; await assert.rejects(flushDraftRequest(r));
  assert.equal(r.state.draft_request.attempted, true);
  await flushDraftRequest(r); assert.equal(remote.drafts.length, 1); assert.equal(remote.calls[0].key, remote.calls[1].key); assert.equal(remote.model.length, 0);
});

test('server policy racing submission preserves the draft without terminating observation', async () => {
  for (const code of ['community_paused', 'community_quiet', 'auto_post_disabled']) {
    const { r } = fixture();
    r.state.draft_request = { key: 'original-draft-key', payload: normalizePostDraft({ title: '原稿', body: '公开分享' }) };
    r.write = async () => { throw Object.assign(new Error('policy'), { code, status: 403 }); };
    assert.equal(await flushDraftRequest(r), false);
    assert.equal(r.state.draft_request.key, 'original-draft-key');
  }
});

test('manual submission does not claim success with a stale previous draft when deferred or cancelled', async () => {
  const runtime = { running: () => false, state: { post_draft: { key: 'old', id: 'old-draft' }, draft_request: { key: 'new' } },
    draftRunKey: 'new', abort: new AbortController(), start() {}, settled: async () => {}, stop() {} };
  const result = await CommunityRuntime.prototype.requestDraft.call(runtime, { title: '新草稿', body: '新正文' });
  assert.equal(result.queued, true); assert.equal(result.draft, undefined); assert.doesNotMatch(result.notice, /草稿已提交/);
});

test('pause while model runs holds original draft locally and does not upload', async () => {
  const { r, remote, advance } = fixture(); const original = r.draftModel;
  r.draftModel = async context => { const value = await original(context); r.preferences.community.paused = true; return value; };
  await serviceProactiveDraft(r); advance(); await serviceProactiveDraft(r);
  assert.equal(remote.calls.length, 0); assert.ok(r.state.draft_request);
  r.preferences.community.paused = false; await flushDraftRequest(r); assert.equal(remote.drafts.length, 1);
});

test('rejected private draft titles never enter the drafting model and manual queue wins an in-flight automatic draft', async () => {
  const { r, remote, advance } = fixture();
  remote.drafts.push({ id: 'draft-private', status: 'rejected', content: { title: 'PRIVATE_REJECTED_TITLE' } });
  const original = r.draftModel;
  r.draftModel = async context => {
    const value = await original(context);
    r.state.draft_request = { key: 'manual-request-1', payload: normalizePostDraft({ title: '人类点的草稿', body: '人类选择的公开分享' }) };
    return value;
  };
  await serviceProactiveDraft(r); advance(); await serviceProactiveDraft(r);
  assert.doesNotMatch(JSON.stringify(remote.model), /PRIVATE_/);
  assert.equal(r.state.draft_request.key, 'manual-request-1'); assert.equal(remote.calls.length, 0);
});

test('lightweight web search uses one public interest query and three results; absence does not retry', async () => {
  const { r, remote, advance } = fixture(); Object.assign(r.preferences.community, { draft_search_enabled: true, keywords: '桌游,二次元' });
  r.draftModel = async context => { remote.model.push(context); return { propose: true, title: '新玩法', body: '这则公开消息看起来有趣，个人期待。来源：https://example.com/game', topics: ['桌游'], note: '公开消息' }; };
  await serviceProactiveDraft(r); advance(); await serviceProactiveDraft(r);
  assert.deepEqual(remote.searches, ['桌游']); assert.equal(remote.calls[0].payload.source.kind, 'public_web');
  const calls = []; const search = createInterestSearch(() => ({ async search(args) { calls.push(args); return { sources: [{ url: 'https://example.com' }, { url: 'http://private' }] }; } }));
  assert.equal((await search('桌游', new AbortController().signal)).length, 1); assert.deepEqual(calls, [{ query: '桌游', maxResults: 3 }]);
  await assert.rejects(createInterestSearch(() => null)('桌游', new AbortController().signal), { code: 'draft_search_unavailable' });
});

test('manual tool queues inside watch without creating a second controller and persists restart-safe request', async t => {
  const directory = join(ROOT, `draft-request-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  t.after(() => { assert.ok(resolve(directory).startsWith(ROOT)); rmSync(directory, { recursive: true }); });
  const binding = { baseUrl: 'http://127.0.0.1:4999', actorId: 'ai-test', scopes: [] };
  const runtime = new CommunityRuntime({ directory, connection: { binding: () => binding } });
  runtime.load(binding); runtime.mode = 'watch'; runtime.task = Promise.resolve(); runtime.abort = new AbortController();
  runtime.preferences = { community: { auto_post: false } };
  const value = await runtime.requestDraft({ title: '刚才那局', body: '想和朋友们分享游戏经历' });
  assert.equal(value.queued, true); assert.ok(runtime.state.draft_request.key);
  const restarted = new CommunityRuntime({ directory, connection: { binding: () => binding } });
  assert.equal(restarted.state.draft_request.key, runtime.state.draft_request.key);
  assert.equal(restarted.state.draft_request.payload.initiation, 'requested');
  assert.equal(publicDraftNotice(binding.baseUrl, { id: 'draft-test', status: 'pending', content: { title: '草稿' } }).review_url, 'http://127.0.0.1:4999/messages?draft=draft-test#post-drafts');
});
