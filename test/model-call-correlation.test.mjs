import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';
import { LocalDiary } from '../lib/local-diary.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createDshGameDecider } from '../lib/game-model.js';
import { createModelCallLogger, safeModelCallId } from '../lib/model-call-log.js';

const CALL_ID = '12345678-1234-4321-8123-123456789abc';
const response = { participate: true, body: 'fixture reply' };
function isolatedDirectory(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'model-correlation-'));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${root}${sep}`) && target !== root);
    rmSync(target, { recursive: true });
  });
  return directory;
}
function modelFixture(value) {
  const entries = [], order = [];
  const logger = createModelCallLogger({ directory: 'unused-model-correlation',
    makeDirectory() {}, append(path, line) { entries.push(JSON.parse(line)); },
    setTimer: () => null, clearTimer() {} });
  const context = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture', reasoningEffort: 'max' }) },
    llm: { async prepareCall() {
      order.push('prepare');
      return { config: {}, async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(value) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    } } };
  return { entries, order, logger, context };
}
for (const kind of ['community', 'game']) {
  test(`${kind} model correlation uses the same safe id before preparation and emits one finish`, async () => {
    const expected = kind === 'community' ? response : { action_id: 'pass', commentary: 'fixture' };
    const f = modelFixture(expected);
    const decide = kind === 'community'
      ? createRuntimeModel(() => f.context, { callLogger: f.logger })
      : createDshGameDecider(f.context, { callLogger: f.logger, monotonic: () => 0 });
    let id;
    const onModelCall = value => { id = value; f.order.push('callback'); throw new Error('diagnostic sink failed'); };
    const result = kind === 'community' ? await decide({}, undefined, undefined, onModelCall)
      : await decide({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { deadline: 10000, onModelCall });
    assert.deepEqual(result, expected);
    assert.deepEqual(f.order, ['callback', 'prepare']);
    assert.equal(safeModelCallId(id), id);
    assert.ok(id);
    assert.equal(decide.last_call_id, id);
    assert.ok(f.entries.every(entry => entry.call_id === id));
    assert.equal(f.entries.filter(entry => entry.event === 'finished').length, 1);
    assert.equal(f.entries.at(-1).phase, 'completed');
  });
}

function runtimeFixture(t, decide) {
  const directory = isolatedDirectory(t);
  const runtime = new CommunityRuntime({ directory, connection: { binding: () => null }, decide,
    now: () => 100 });
  runtime.stateFile = join(directory, 'runtime.json');
  runtime.diary = new LocalDiary({ directory, baseUrl: 'http://127.0.0.1:1', actorId: 'ai-fixture' });
  runtime.state = { version: 1, identity: { base_url: 'http://127.0.0.1:1', actor_id: 'ai-fixture' },
    model_calls: 0, replies: 0, posts: 0, cursor: '0', discovery_cursor: '0', completed: [], pending: null };
  runtime.abort = new AbortController();
  runtime.actor = { id: 'ai-fixture', name: 'AI', kind: 'ai' };
  runtime.lease = { epoch: 1, deadline: 1000 };
  runtime.limits = { max_model_calls: 10, max_replies: 10, max_posts: 1 };
  const preferenceReads = [];
  runtime.api = { async data(path, { signal } = {}) {
    assert.equal(path, '/api/v1/agent/preferences');
    signal?.throwIfAborted(); preferenceReads.push(path);
    return { community: { configured: false, paused: false, proactive_comments: true,
      reply_to_interactions: true, reply_remaining: null, quiet_now: false }, diary: { enabled: false, timezone: 'Asia/Shanghai' } };
  } };
  runtime.get = async path => path.includes('/comments?') ? { data: [] }
    : { data: { id: path.split('/').at(-1), title: 'Fixture', body: 'public fixture', author: { id: 'human', kind: 'human' } } };
  const submissions = [];
  runtime.write = async (path, body, key) => { submissions.push({ path, body, key }); return { id: 'comment-fixture', status: 'queued' }; };
  return { runtime, submissions, preferenceReads, invoke: (postId = 'post-fixture') => runtime.decideOn(postId, `browse:${postId}`, null, null, {}) };
}
const reportedDecision = value => async (context, signal, diagnostic, onCall) => { onCall(CALL_ID); return value; };

test('community submitted state correlates the original id without changing the posted body', async t => {
  const f = runtimeFixture(t, reportedDecision(response));
  await f.invoke();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.preferenceReads.length, 1, 'posting rereads current account policy');
  assert.deepEqual(f.submissions[0].body, { body: response.body, parent_id: null, ai_generated: true });
  assert.deepEqual(f.runtime.publicStatus().last_model_call, { call_id: CALL_ID, status: 'submitted', reason: null });
  assert.equal(f.runtime.publicStatus().last_submission.call_id, CALL_ID);
  assert.equal(f.runtime.publicStatus().last_submission.status, 'queued');
  assert.equal(JSON.parse(readFileSync(f.runtime.stateFile, 'utf8')).last_submission.call_id, CALL_ID);
});

test('community uncertain submission retains original body key and call id when resumed', async t => {
  const f = runtimeFixture(t, reportedDecision(response));
  const write = f.runtime.write;
  f.runtime.write = async (...args) => { await write(...args); throw Object.assign(new Error('lost receipt'), { code: 'network_error' }); };
  await assert.rejects(f.invoke(), { code: 'network_error' });
  assert.equal(f.runtime.publicStatus().pending.call_id, CALL_ID);
  assert.equal(f.runtime.publicStatus().last_model_call.status, 'pending');
  const pending = JSON.parse(readFileSync(f.runtime.stateFile, 'utf8')).pending;
  f.runtime.write = write;
  await f.runtime.flushPending();
  assert.equal(f.submissions.length, 2);
  assert.equal(f.preferenceReads.length, 2, 'receipt reconciliation also checks current account policy');
  assert.deepEqual(f.submissions[1], f.submissions[0]);
  assert.equal(f.submissions[1].key, pending.key);
  assert.equal(f.runtime.publicStatus().last_submission.call_id, CALL_ID);
  assert.equal(f.runtime.state.model_calls, 1);
});

test('complete community output is already saved and remains pending during a post-model connection failure', async t => {
  const f = runtimeFixture(t, reportedDecision(response));
  f.runtime.connectionReady = async () => {
    const saved = JSON.parse(readFileSync(f.runtime.stateFile, 'utf8'));
    assert.equal(saved.pending.payload.body, response.body);
    assert.equal(saved.pending.call_id, CALL_ID);
    assert.equal(saved.model_attempt, null);
    throw Object.assign(new Error('fixture connection lost'), { code: 'network_error' });
  };
  await assert.rejects(f.invoke(), { code: 'network_error' });
  assert.equal(f.submissions.length, 0);
  assert.equal(f.runtime.publicStatus().last_model_call.status, 'pending');
});

for (const reason of ['stopped', 'expired']) {
  test(`community ${reason} call retains its id and makes no submission`, async t => {
    let f;
    f = runtimeFixture(t, async (context, signal, diagnostic, onCall) => {
      onCall(CALL_ID);
      if (reason === 'stopped') f.runtime.abort.abort(); else f.runtime.lease.deadline = 99;
      return response;
    });
    await assert.rejects(f.invoke(), { code: reason === 'stopped' ? 'run_stopped' : 'control_lost' });
    assert.deepEqual(f.runtime.publicStatus().last_model_call, { call_id: CALL_ID, status: 'discarded', reason });
    assert.equal(f.submissions.length, 0);
  });
}

test('community declined and model-failed decisions retain distinct outcomes without posting', async t => {
  const f = runtimeFixture(t, reportedDecision({ participate: false, body: '' }));
  await f.invoke();
  assert.equal(f.runtime.publicStatus().last_model_call.status, 'declined');
  f.runtime.decide = async (context, signal, diagnostic, onCall) => { onCall(CALL_ID); throw new Error('fixture'); };
  // The declined first post is now persistently deduplicated; use new content
  // to exercise model failure rather than bypassing content deduplication.
  await assert.rejects(f.invoke('post-failed-fixture'), /fixture/);
  assert.equal(f.runtime.state.model_calls, 2);
  assert.equal(f.runtime.publicStatus().last_model_call.status, 'model_failed');
  assert.equal(f.submissions.length, 0);
});

test('community correlation persistence failure cannot block an otherwise valid submission', async t => {
  const f = runtimeFixture(t, reportedDecision(response));
  const commit = f.runtime.commit.bind(f.runtime);
  f.runtime.commit = patch => {
    if (Object.keys(patch).length === 1 && patch.last_model_call) throw new Error('diagnostic storage failed');
    return commit(patch);
  };
  await f.invoke();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.runtime.publicStatus().last_submission.call_id, CALL_ID);
});

test('community strips invalid ids and ignores callbacks belonging to an old identity', async t => {
  const f = runtimeFixture(t, async (context, signal, diagnostic, onCall) => { onCall('private-text-not-an-id'); return response; });
  await f.invoke();
  assert.equal(f.runtime.publicStatus().last_model_call, null);
  assert.equal(f.runtime.publicStatus().last_submission.call_id, null);
  f.runtime.decide = async (context, signal, diagnostic, onCall) => {
    f.runtime.state = { ...f.runtime.state, identity: { ...f.runtime.state.identity, actor_id: 'other-ai' } };
    onCall(CALL_ID);
    f.runtime.abort.abort();
    return response;
  };
  await assert.rejects(f.invoke('post-old-identity-fixture'), { code: 'run_stopped' });
  assert.equal(f.runtime.state.model_calls, 2);
  assert.equal(f.runtime.publicStatus().last_model_call, null);
  assert.equal(f.submissions.length, 1);
});
