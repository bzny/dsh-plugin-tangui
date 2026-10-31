import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeModel, parseDecision } from '../lib/runtime-model.js';
import { createDshNormalizer } from '../lib/dsh-normalizer.js';
import { createDshGameDecider } from '../lib/game-model.js';
import { createModelCallLogger } from '../lib/model-call-log.js';
import { PERSONA_FIELDS } from '../lib/persona-normalization.js';

const good = { participate: true, body: '这是一条有效回复。' };
const finish = (kind = 'stop', code) => ({ type: 'finish', reason: { kind, ...(code ? { failure: { code, message: 'PRIVATE_UPSTREAM' } } : {}) } });
const chunks = value => [{ type: 'text-delta', index: 0, text: typeof value === 'string' ? value : JSON.stringify(value) }, finish()];
function harness(outputs) {
  const f = { calls: [], requests: [], logs: [] };
  f.route = { provider: 'test', model: 'glm-fixture', reasoningEffort: 'max' };
  // Services are intentionally inherited; spreading this context would lose them.
  f.ctx = Object.create({ llm: { async prepareCall(config, signal) {
    f.calls.push({ config, signal }); const index = f.calls.length - 1;
    return { config, async *stream(request) {
      f.requests.push(request);
      const output = outputs[Math.min(index, outputs.length - 1)];
      if (output instanceof Error) throw output;
      yield* output;
    } };
  } }, agentDefaultModel: { currentSelection: () => f.route } });
  Object.defineProperty(f.ctx, 'agents', { get() { throw new Error('Private service accessed'); }, enumerable: true });
  f.logger = createModelCallLogger({ directory: 'unused-model-retry-fixture', makeDirectory() {}, setTimer: () => null,
    append(path, line) { f.logs.push(JSON.parse(line)); } });
  f.options = { callLogger: f.logger, retryDelays: [0, 0] };
  return f;
}

test('invalid decision then valid: bounded recovery keeps model, reasoning and 64k, exposes only known validation metadata', async () => {
  const f = harness([chunks({ participate: 'yes', body: 'PRIVATE_INVALID_RESPONSE' }), chunks(good)]);
  let reserved = 0;
  const result = await createRuntimeModel(() => f.ctx, f.options)({}, undefined, undefined, undefined, { beforeRetry: () => { reserved++; } });
  assert.deepEqual(result, good); assert.equal(f.calls.length, 2); assert.equal(reserved, 1);
  const ended = f.logs.filter(x => x.event === 'finished');
  assert.deepEqual(ended.map(x => x.attempt), [1, 2]);
  assert.equal(ended[0].validation_reason, 'field_type'); assert.equal(ended[0].validation_field, 'participate');
  assert.equal(ended[1].phase, 'completed'); assert.equal(ended[0].retry_group_id, ended[1].retry_group_id);
  assert.match(f.requests[1].system, /field_type.*participate/);
  assert.doesNotMatch(f.requests[1].system, /PRIVATE_INVALID_RESPONSE/);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_INVALID_RESPONSE/);
  for (const call of f.calls) assert.deepEqual(call.config, { ...f.route, maxTokens: 64000 });
});

test('three invalid results stop with no accepted decision and a diagnostic exhaustion event', async () => {
  const f = harness([chunks('bad json PRIVATE_OUTPUT')]); let reservations = 0;
  await assert.rejects(() => createRuntimeModel(() => f.ctx, f.options)({}, undefined, undefined, undefined, { beforeRetry: () => { reservations++; } }),
    error => error.code === 'invalid_model_decision' && error.attempts === 3 && !error.message.includes('PRIVATE_OUTPUT'));
  assert.equal(f.calls.length, 3); assert.equal(reservations, 2);
  assert.equal(f.logs.at(-1).retry_status, 'exhausted');
  assert.equal(f.logs.at(-1).validation_reason, 'json_syntax');
});

test('unknown model fields never enter diagnostics and invalid catalog choices can recover', async () => {
  assert.throws(() => parseDecision({}), e => e.validation_reason === 'empty_output');
  assert.throws(() => parseDecision(JSON.stringify({ ...good, 'PRIVATE_FIELD_NAME': 1 })), e => e.validation_reason === 'unknown_field' && e.validation_field === null);
  const f = harness([chunks({ ...good, sticker_codes: ['invented'] }), chunks(good)]);
  assert.deepEqual(await createRuntimeModel(() => f.ctx, f.options)({ available_stickers: [] }), good);
  assert.equal(f.logs.find(e => e.event === 'finished').validation_reason, 'invalid_sticker');
});

test('permanent provider failures and output quota do not retry in any model adapter', async () => {
  for (const adapter of ['community', 'normalizer', 'game']) for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'CONTENT_FILTER', 'REFUSAL', 'max-tokens']) {
    const f = harness([[finish(code === 'max-tokens' ? code : 'error', code === 'max-tokens' ? undefined : code)]]);
    const run = adapter === 'community' ? () => createRuntimeModel(() => f.ctx, f.options)({})
      : adapter === 'normalizer' ? () => createDshNormalizer(f.ctx, f.options)({ description: '我是测试伙伴。' })
        : () => createDshGameDecider(() => f.ctx, { ...f.options, monotonic: () => 0 })({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { deadline: 10000 });
    await assert.rejects(run); assert.equal(f.calls.length, 1, `${adapter} ${code}`);
    assert.equal(f.logs.some(e => e.event === 'retry'), false);
  }
});

test('transient transport, rate limit and incomplete stream recover without submitting any previous content', async () => {
  for (const bad of [[finish('error', 'RATE_LIMIT')], [finish('error', 'TRANSPORT')], chunks(good).slice(0, 1)]) {
    const f = harness([bad, chunks(good)]);
    assert.deepEqual(await createRuntimeModel(() => f.ctx, f.options)({}), good);
    assert.equal(f.calls.length, 2);
  }
});

test('budget refusal and model selection change stop before next dispatch', async () => {
  const f = harness([chunks('bad'), chunks(good)]);
  await assert.rejects(() => createRuntimeModel(() => f.ctx, f.options)({}, undefined, undefined, undefined,
    { beforeRetry() { throw Object.assign(new Error('Budget used'), { code: 'budget_exhausted' }); } }), { code: 'budget_exhausted' });
  assert.equal(f.calls.length, 1); assert.equal(f.logs.at(-1).retry_status, 'stopped');
  const g = harness([chunks('bad'), chunks(good)]);
  await assert.rejects(() => createRuntimeModel(() => g.ctx, g.options)({}, undefined, undefined, undefined,
    { beforeRetry() { g.route = { ...g.route, model: 'changed-model' }; } }), { code: 'model_route_changed' });
  assert.equal(g.calls.length, 1);
});

test('cancel during backoff cannot leak an arbitrary abort reason or reserve another call', async () => {
  const f = harness([chunks('bad'), chunks(good)]), controller = new AbortController();
  let reserved = 0;
  const run = createRuntimeModel(() => f.ctx, { ...f.options, retryDelays: [1000] });
  const pending = run({}, controller.signal, () => { setImmediate(() => controller.abort('PRIVATE_ABORT_REASON')); }, undefined, { beforeRetry: () => { reserved++; } });
  await assert.rejects(() => pending, e => e.code === 'run_stopped' && !JSON.stringify(e).includes('PRIVATE_ABORT_REASON'));
  assert.equal(f.calls.length, 1); assert.equal(reserved, 0); assert.equal(f.logs.at(-1).retry_status, 'cancelled');
});

test('game retries fit the original deadline, count reservations and return one legal choice', async () => {
  const f = harness([chunks({ action_id: 'invented' }), chunks({ action_id: 'pass' })]);
  let reserved = 0;
  const run = createDshGameDecider(() => f.ctx, { ...f.options, monotonic: () => 0 });
  assert.deepEqual(await run({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { deadline: 10000, beforeRetry: () => { reserved++; } }), { action_id: 'pass', commentary: '' });
  assert.equal(reserved, 1); assert.equal(f.logs.filter(x => x.event === 'finished')[0].validation_field, 'action_id');
  const g = harness([chunks('bad'), chunks({ action_id: 'pass' })]);
  await assert.rejects(() => createDshGameDecider(() => g.ctx, { ...g.options, retryDelays: [1000] })({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { deadline: performance.now() + 430 }), { code: 'game_decision_cancelled' });
  assert.equal(g.calls.length, 1);
});

test('persona retries return a single grounded normalization and record safe validation categories', async () => {
  const description = '我是小鱼。';
  const f = harness([chunks('bad'), chunks({ name: { value: '小鱼', evidence: '我是小鱼' }, overrides: Object.fromEntries(PERSONA_FIELDS.map(k => [k, null])) })]);
  const result = await createDshNormalizer(f.ctx, f.options)({ description });
  assert.equal(result.name, '小鱼'); assert.equal(f.calls.length, 2);
  assert.equal(f.logs.find(e => e.event === 'finished').validation_reason, 'json_syntax');
});

test('broken diagnostics never repeat an otherwise successful generation', async () => {
  const f = harness([chunks(good)]);
  const logger = { start() { return { observe() { throw new Error(); }, finish() { throw new Error(); }, retry() { throw new Error(); } }; } };
  assert.deepEqual(await createRuntimeModel(() => f.ctx, { callLogger: logger })({}), good);
  assert.equal(f.calls.length, 1);
});
