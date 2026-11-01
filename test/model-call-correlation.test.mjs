import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';
import { LocalDiary, parseDiary } from '../lib/local-diary.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createDshGameDecider } from '../lib/game-model.js';
import { createModelCallLogger, safeModelCallId } from '../lib/model-call-log.js';

const CALL_ID = '12345678-1234-4321-8123-123456789abc';
const response = { participate: true, reply_to_actor_id: 'human', body: 'fixture reply' };
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

function retryModel(outputs, options = {}) {
  const f = { calls: 0 };
  f.decide = createRuntimeModel(() => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { async prepareCall(config) {
      const value = outputs[Math.min(f.calls++, outputs.length - 1)];
      return { config, async *stream() {
        yield { type: 'text-delta', index: 0, text: typeof value === 'string' ? value : JSON.stringify(value) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    } } }), { retryDelays: [0, 0], ...options });
  return f;
}

test('community invalid output retries are charged durably and only one valid reply reaches submission', async t => {
  const model = retryModel(['bad JSON', response]); const f = runtimeFixture(t, model.decide);
  await f.invoke();
  assert.equal(model.calls, 2); assert.equal(f.runtime.state.model_calls, 2);
  assert.equal(JSON.parse(readFileSync(f.runtime.stateFile, 'utf8')).model_calls, 2);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].body.body, response.body);
  assert.equal(f.runtime.state.replies, 1);
  assert.equal(new Set(f.runtime.state.completed).size, f.runtime.state.completed.length);
});

test('wrong relationship address is retried before any public submission, with only actor ids in logs', async t => {
  const logs = [];
  const logger = createModelCallLogger({ directory: 'unused-identity-logger', makeDirectory() {},
    setTimer: () => null, append(_path, line) { logs.push(JSON.parse(line)); } });
  const model = retryModel([{ ...response, body: '阿宁你这标题真是太真实了。' }, response], { callLogger: logger });
  const f = runtimeFixture(t, model.decide);
  Object.assign(f.runtime.actor, { relationship: 'companion', linked_human_id: 'human-manager' });
  const persona = { description: '只用于测试的人设。', effective: { manager_address: '称呼人类管理者为“阿宁”' } };
  await f.runtime.decideOn('post-fixture', 'browse:post-fixture', null, null, persona);
  assert.equal(model.calls, 2); assert.equal(f.runtime.state.model_calls, 2);
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].body.body, response.body);
  const finished = logs.filter(row => row.event === 'finished');
  assert.equal(finished[0].validation_reason, 'manager_address_misuse');
  assert.equal(finished[0].reply_target_actor_id, 'human');
  assert.equal(finished[0].reply_target_is_linked_human, false);
  assert.equal(finished[1].phase, 'completed');
  assert.doesNotMatch(JSON.stringify(logs), /阿宁|只用于测试的人设/);
});

test('repeated recipient confusion exhausts the existing budgeted retries without publishing or recording a false experience', async t => {
  const model = retryModel([{ ...response, reply_to_actor_id: 'human-manager' }]);
  const f = runtimeFixture(t, model.decide);
  await assert.rejects(f.invoke(), error => error.validation_reason === 'reply_target_mismatch' && error.attempts === 3);
  assert.equal(model.calls, 3); assert.equal(f.runtime.state.model_calls, 3);
  assert.equal(f.submissions.length, 0); assert.equal(f.runtime.state.pending, null);
  assert.equal(f.runtime.diary.status().entry_count, 0);
});

test('community exhausted retries or budget write no reply, thought or read-completion', async t => {
  for (const budget of [1, 2, 5]) {
    const model = retryModel(['bad JSON']); const f = runtimeFixture(t, model.decide);
    f.runtime.limits.max_model_calls = budget;
    await assert.rejects(f.invoke(), { code: budget < 3 ? 'budget_exhausted' : 'invalid_model_decision' });
    assert.equal(model.calls, Math.min(3, budget)); assert.equal(f.runtime.state.model_calls, Math.min(3, budget));
    assert.equal(f.runtime.state.pending, null); assert.equal(f.submissions.length, 0);
    assert.equal(f.runtime.state.completed.length, 0); assert.equal(f.runtime.diary.status().entry_count, 0);
    assert.equal(JSON.parse(readFileSync(f.runtime.stateFile, 'utf8')).model_calls, Math.min(3, budget));
  }
});

test('successful retry followed by an unknown submission receipt resends same request without regenerating', async t => {
  const model = retryModel(['bad JSON', response]); const f = runtimeFixture(t, model.decide), write = f.runtime.write;
  f.runtime.write = async (...args) => { await write(...args); throw Object.assign(new Error('lost receipt'), { code: 'network_error' }); };
  await assert.rejects(f.invoke(), { code: 'network_error' });
  f.runtime.write = write; await f.runtime.flushPending();
  assert.equal(model.calls, 2); assert.equal(f.runtime.state.model_calls, 2);
  assert.deepEqual(f.submissions[0], f.submissions[1]);
});

test('model retry refuses changed control or identity before charging another call', async t => {
  for (const change of ['identity', 'epoch']) {
    const model = retryModel(['bad JSON', response]); const f = runtimeFixture(t, model.decide);
    f.runtime.connectionReady = async () => {
      if (change === 'epoch') f.runtime.lease.epoch++;
      else f.runtime.state.identity = { ...f.runtime.state.identity, actor_id: 'other-ai' };
    };
    await assert.rejects(f.invoke(), { code: 'run_stopped' });
    assert.equal(model.calls, 1); assert.equal(f.runtime.state.model_calls, 1); assert.equal(f.submissions.length, 0);
  }
});

test('diary retries charge the community budget and completed diary is never regenerated', async t => {
  const model = retryModel(['', '今天留下了一段值得记住的交流。'], { purpose: 'diary_summary', parse: parseDiary });
  const f = runtimeFixture(t, reportedDecision(response));
  f.runtime.preferences = { diary: {}, community: {} }; f.runtime.summarize = model.decide; f.runtime.configuration = async () => ({});
  f.runtime.diary.record({ id: 'entry-1', occurred_at: '2026-11-01T01:00:00Z', kind: 'post_read', reaction: 'noted', reflection: '这是本机测试经历。' });
  f.runtime.api.data = async () => ({ jobs: [{ id: 'diary-job', actor_id: 'ai-fixture', since: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z', status: 'pending' }] });
  await f.runtime.serviceDiary(); assert.equal(model.calls, 2); assert.equal(f.runtime.state.model_calls, 2);
  assert.equal(f.submissions[0].body.status, 'completed');
  await f.runtime.serviceDiary(); assert.equal(model.calls, 2); assert.equal(f.runtime.state.model_calls, 2);
});

test('an update waits through generation retry and observes only the completed action boundary', async t => {
  let f, scheduled = 0;
  const model = retryModel(['bad JSON', response], { callLogger: { start() { return { retry(entry) {
    if (entry.status === 'scheduled') { scheduled++; f.runtime.activity.requestPause(); assert.equal(f.runtime.activity.canPark(), false); }
  } }; } } });
  f = runtimeFixture(t, model.decide); f.runtime.activity.start('watch');
  await f.runtime.performAction('reply', () => f.invoke());
  assert.equal(scheduled, 1); assert.equal(f.runtime.activity.canPark(), true); assert.equal(f.submissions.length, 1);
});

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
