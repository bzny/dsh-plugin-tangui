import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CommunityRuntime } from '../lib/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const event = (id, type = 'comment.mentioned', extra = {}) => ({ id: String(id), type,
  post_id: 'post-test', resource_id: type === 'post.mentioned' ? 'post-test' : 'comment-target',
  reply_to_actor_id: 'ai-test', author_id: 'human-test', created_at: '2026-10-28T08:00:00Z', ...extra });

function fixture(t) {
  const directory = join(ROOT, `runtime-social-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const binding = { baseUrl: 'http://127.0.0.1:4999', actorId: 'ai-test', token: 'FAKE_TEST_TOKEN', scopes: ['posts:read', 'comments:write', 'events:read'] };
  const actor = { id: 'ai-test', name: '测试伙伴', kind: 'ai' };
  const persona = { description: '测试伙伴', effective: Object.fromEntries(['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'].map(key => [key, ''])) };
  const remote = { events: [], reads: [], submissions: [], accepted: new Map(), contexts: [], participate: true,
    target: { id: 'comment-target', post_id: 'post-test', status: 'published', body: '@测试伙伴 你怎么看？', author: { id: 'human-test' } } };
  const send = (data, extra = {}) => ({ ok: true, status: 200, json: async () => ({ data, ...extra }) });
  const error = (code, status) => ({ ok: false, status, json: async () => ({ error: { code } }) });
  const fetchImpl = async (url, request) => {
    const path = new URL(url).pathname, body = request.body ? JSON.parse(request.body) : null;
    remote.reads.push(path);
    if (path === '/api/v1/me') return send({ actor, scopes: binding.scopes });
    if (path === '/api/v1/capabilities') return send({ features: {} });
    if (path === '/api/v1/agent/control/acquire') return send({ actor_id: actor.id, active: true, owned_by_current_grant: true, epoch: 1,
      server_time: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), renew_after_seconds: 15 });
    if (path === '/api/v1/agent/control/release') return send({ active: false });
    if (path === '/api/v1/agent/configuration') return send({ actor, persona });
    if (path === '/api/v1/agent/preferences') return remote.preferences ? send(remote.preferences) : error('not_found', 404);
    if (path === '/api/v1/events') return send(remote.events, { next_cursor: remote.events.at(-1)?.id || '0' });
    if (path === '/api/v1/posts') return send(remote.posts || []);
    if (path === '/api/v1/posts/post-test') {
      if (remote.readError) return error(...remote.readError);
      if (remote.networkError) throw new Error('fake network outage');
      return send({ id: 'post-test', title: '讨论', body: '@测试伙伴 来聊聊', author: { id: 'human-test' } });
    }
    if (path === '/api/v1/posts/post-test/comments' && request.method === 'GET') return send([], { next_cursor: '50' });
    if (path === '/api/v1/comments/comment-target') return send(remote.target);
    if (path === '/api/v1/posts/post-test/comments' && request.method === 'POST') {
      const key = request.headers['Idempotency-Key']; remote.submissions.push({ key, body });
      if (remote.submitError) return error(...remote.submitError);
      if (!remote.accepted.has(key)) remote.accepted.set(key, { id: 'reply-test', status: 'published' });
      if (remote.loseResponse) { remote.loseResponse = false; throw new Error('fake lost response'); }
      return send(remote.accepted.get(key));
    }
    throw new Error(`Unexpected test path ${path}`);
  };
  const instances = [];
  const make = () => {
    const runtime = new CommunityRuntime({ directory, connection: { binding: () => binding }, fetchImpl,
      decide: async context => { remote.contexts.push(context); return { participate: remote.participate, body: remote.participate ? '我有一个想法。' : '', reflection: remote.reflection || '' }; } });
    instances.push(runtime); return runtime;
  };
  const run = async runtime => { runtime.start(); await runtime.settled(); return runtime.publicStatus(); };
  t.after(async () => {
    for (const runtime of instances) { runtime.stop(); await runtime.settled(); }
    assert.ok(resolve(directory).startsWith(`${ROOT}\\`) || resolve(directory).startsWith(`${ROOT}/`));
    rmSync(directory, { recursive: true });
  });
  return { remote, make, run };
}

test('post @ replies to the post, marks browse complete and never reads a comment with the post ID', async t => {
  const f = fixture(t); f.remote.events = [event(1, 'post.mentioned')];
  const runtime = f.make(); await f.run(runtime);
  assert.equal(f.remote.contexts[0].reply_to_comment_id, null);
  assert.equal(f.remote.submissions[0].body.parent_id, null);
  assert.ok(runtime.state.completed.includes('browse:post-test'));
  assert.ok(!f.remote.reads.includes('/api/v1/comments/post-test'));
});

test('post @ is an interaction when proactive replies are disabled and retains private diary reflection', async t => {
  const f = fixture(t); f.remote.events = [event(1, 'post.mentioned')];
  f.remote.preferences = { community: { configured: true, proactive_comments: false, reply_to_interactions: true }, diary: {} };
  f.remote.reflection = 'PRIVATE_REFLECTION：想和伙伴一起聊聊。';
  const runtime = f.make(); await f.run(runtime);
  assert.equal(runtime.publicStatus().error, null); assert.equal(f.remote.submissions.length, 1);
  assert.equal(f.remote.submissions[0].body.parent_id, null);
  const entries = [...runtime.diary.entries()];
  assert.deepEqual(entries.map(entry => entry.kind), ['post_read', 'comment_submitted']);
  assert.equal(entries[1].related_entry_id, 'event:1:read');
  assert.doesNotMatch(JSON.stringify(f.remote.submissions[0]), /PRIVATE_REFLECTION/);
});

test('deferred browse and post @ reuse the original draft, diary link and forward event position', async t => {
  const f = fixture(t); f.remote.posts = [{ id: 'post-test', author: { id: 'human-test' } }];
  f.remote.preferences = { community: { configured: true, proactive_comments: true, reply_to_interactions: true }, diary: {} };
  f.remote.reflection = '值得记住的私人感想。'; f.remote.submitError = ['proactive_comments_disabled', 403];
  const first = f.make(); await f.run(first); const key = first.state.deferred_pending[0].key;
  f.remote.preferences.community.proactive_comments = false; f.remote.submitError = null;
  f.remote.events = [event(1, 'post.mentioned'), event(2, 'post.mentioned')];
  const restarted = f.make(); await f.run(restarted);
  assert.equal(f.remote.contexts.length, 1); assert.equal(restarted.state.deferred_pending[0].key, key);
  assert.equal(restarted.state.cursor, '2');
  f.remote.preferences.community.proactive_comments = true; await f.run(restarted);
  assert.equal(restarted.state.cursor, '2'); assert.equal(f.remote.submissions.at(-1).key, key);
  const entries = [...restarted.diary.entries()];
  assert.deepEqual(entries.map(entry => entry.kind), ['post_read', 'comment_submitted']);
  assert.equal(entries[1].related_entry_id, 'browse:post-test:read');
});

test('a legacy proactive pending draft with a saved cursor does not become an interaction', async t => {
  const f = fixture(t); f.remote.preferences = { community: { configured: true, proactive_comments: false, reply_to_interactions: true }, diary: {} };
  const runtime = f.make(); runtime.commit({ pending: { kind: 'comment', key: 'legacy-draft-key', post_id: 'post-test',
    action: 'browse:post-test', event_cursor: '1', attempted: false, payload: { body: '原主动评论', parent_id: null, ai_generated: true } } });
  await f.run(runtime);
  assert.equal(f.remote.submissions.length, 0); assert.equal(f.remote.contexts.length, 0);
  assert.equal(runtime.state.pending, null); assert.equal(runtime.state.deferred_pending[0].key, 'legacy-draft-key');
});
test('comment @ fetches its target outside the first comments page', async t => {
  const f = fixture(t); f.remote.events = [event(1)]; await f.run(f.make());
  assert.equal(f.remote.contexts[0].reply_to_comment_id, 'comment-target');
  assert.equal(f.remote.contexts[0].comments.at(-1).body, f.remote.target.body);
  assert.equal(f.remote.submissions[0].body.parent_id, 'comment-target');
});

test('reply, group reply and mention of the same comment generate once across restart', async t => {
  const f = fixture(t); f.remote.events = [event(1, 'comment.published'), event(2), event(3, 'comment.group_replied')];
  await f.run(f.make()); const restarted = f.make(); await f.run(restarted);
  assert.equal(f.remote.contexts.length, 1); assert.equal(f.remote.submissions.length, 1);
  assert.equal(restarted.state.cursor, '3');
});

test('declined comment decision is persistently deduplicated too', async t => {
  const f = fixture(t); f.remote.participate = false; f.remote.events = [event(1), event(2, 'comment.published')];
  await f.run(f.make()); await f.run(f.make());
  assert.equal(f.remote.contexts.length, 1); assert.equal(f.remote.submissions.length, 0);
});

test('pending original wins over duplicate events and lost submit reply reuses its key', async t => {
  const f = fixture(t); f.remote.events = [event(1), event(2, 'comment.published')]; f.remote.loseResponse = true;
  const first = f.make(); await f.run(first); const key = first.state.pending.key;
  const restarted = f.make(); await f.run(restarted); await f.run(restarted);
  assert.deepEqual(f.remote.submissions.map(item => item.key), [key, key]);
  assert.equal(f.remote.accepted.size, 1); assert.equal(f.remote.contexts.length, 1);
  assert.equal(restarted.state.replies, 1); assert.equal(restarted.state.cursor, '2');
});

test('blocked or deleted content retires its event without a model call', async t => {
  const f = fixture(t); f.remote.events = [event(1), event(2)]; f.remote.readError = ['not_found', 404];
  await f.run(f.make()); const restarted = f.make(); await f.run(restarted);
  assert.equal(restarted.state.cursor, '2'); assert.equal(restarted.state.model_calls, 0);
  assert.equal(f.remote.contexts.length, 0); assert.equal(f.remote.submissions.length, 0);
});

test('a block after discovery skips the browse target without changing event position or budget', async t => {
  const f = fixture(t); f.remote.posts = [{ id: 'post-test', author: { id: 'human-test' } }];
  f.remote.readError = ['not_found', 404];
  const runtime = f.make(); runtime.commit({ cursor: '12' }); await f.run(runtime);
  const restarted = f.make(); await f.run(restarted);
  assert.ok(restarted.state.completed.includes('browse:post-test'));
  assert.equal(restarted.state.cursor, '12'); assert.equal(restarted.state.model_calls, 0);
  assert.equal(f.remote.contexts.length, 0); assert.equal(restarted.publicStatus().error, null);
});

test('authentication and transport failures preserve the unhandled event', async t => {
  const f = fixture(t); f.remote.events = [event(1)];
  for (const status of [401, 403]) {
    f.remote.readError = [status === 401 ? 'unauthorized' : 'forbidden', status];
    const runtime = f.make(); await f.run(runtime);
    assert.equal(runtime.state.cursor, '0'); assert.deepEqual(runtime.state.completed, []);
  }
  f.remote.readError = null; f.remote.networkError = true; const runtime = f.make(); await f.run(runtime);
  assert.equal(runtime.state.cursor, '0'); assert.equal(f.remote.contexts.length, 0);
});

test('submission 404 never discards a generated pending original', async t => {
  const f = fixture(t); f.remote.events = [event(1)]; f.remote.submitError = ['not_found', 404];
  const runtime = f.make(); await f.run(runtime);
  assert.ok(f.make().state.pending); assert.equal(runtime.state.cursor, '0'); assert.equal(f.remote.contexts.length, 1);
});

test('likes, friend requests, self mentions and other recipients never trigger model calls', async t => {
  const f = fixture(t); f.remote.events = [event(1, 'like.created'), event(2, 'friend.requested'),
    event(3, 'comment.mentioned', { author_id: 'ai-test' }), event(4, 'comment.mentioned', { reply_to_actor_id: 'another-ai' })];
  const runtime = f.make(); await f.run(runtime);
  assert.equal(runtime.state.cursor, '4'); assert.equal(f.remote.contexts.length, 0);
});

test('friend facts keep server time and survive cursor replay without model calls or invented feelings', async t => {
  const shared = { account: { id: 'account-sender', type: 'pair', name: '公开人类 + 公开伙伴', members: [
    { id: 'human-test', name: '公开人类', kind: 'human' }, { id: 'ai-sender', name: '公开伙伴', kind: 'ai' },
  ] } };
  const f = fixture(t); f.remote.events = [event(1, 'friend.requested', { resource_id: 'friend-test', post_id: null, ...shared }),
    event(2, 'friend.accepted', { resource_id: 'friend-test', post_id: null, author_id: 'ai-test', ...shared }),
    event(3, 'friend.accepted', { resource_id: 'other-friend', post_id: null, reply_to_actor_id: 'another-ai' }),
    event(4, 'friend.requested', { resource_id: 'human-friend', post_id: null, reply_to_actor_id: 'human-self' })];
  const runtime = f.make(); await f.run(runtime);
  const entries = [...runtime.diary.entries()];
  assert.deepEqual(entries.map(entry => entry.kind), ['friend_requested', 'friend_accepted']);
  assert.doesNotMatch(entries[0].summary, /已被接受/); assert.match(entries[1].summary, /已被接受/);
  assert.ok(entries.every(entry => entry.reaction === null && entry.reflection === '' && entry.occurred_at === '2026-10-28T08:00:00Z'));
  runtime.commit({ cursor: '0' }); // Crash after diary flush but before cursor save.
  const restarted = f.make(); await f.run(restarted);
  assert.equal([...restarted.diary.entries()].length, 2); assert.equal(restarted.state.cursor, '4');
  assert.equal(restarted.state.model_calls, 0); assert.equal(f.remote.contexts.length, 0); assert.equal(f.remote.submissions.length, 0);
});

test('malformed post mention and wrong-thread target fail before model calls', async t => {
  const f = fixture(t); f.remote.events = [event(1, 'post.mentioned', { resource_id: 'other-post' })];
  assert.equal((await f.run(f.make())).error.code, 'invalid_reply_event');
  f.remote.events = [event(1)]; f.remote.target.post_id = 'other-post';
  assert.equal((await f.run(f.make())).error.code, 'invalid_reply_target');
  assert.equal(f.remote.contexts.length, 0);
});
