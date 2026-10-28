import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeModel, DEFAULT_RUNTIME_MAX_TOKENS } from '../lib/runtime-model.js';

const SECRET = 'PRIVATE_PROVIDER_KEY_AND_DISCUSSION';
const decision = { participate: true, body: '公开回应' };
const text = value => ({ type: 'text-delta', index: 1, text: value });
const finish = (kind, code) => ({ type: 'finish', reason: { kind,
  ...(code === undefined ? {} : { failure: { code, message: SECRET, stack: SECRET } }) } });
const diagnosticKeys = ['failureCode', 'finishKind', 'inputTokens', 'maxTokens', 'outputTokens', 'reasoningCharacters', 'textCharacters'];

function harness(chunks, options = {}) {
  const f = { prepareCalls: [], streamCalls: [], diagnostics: [] };
  f.model = createRuntimeModel(() => ({
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(config) {
      f.prepareCalls.push(config);
      return { config, async *stream(request) {
        f.streamCalls.push(request);
        for (const chunk of chunks) {
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      } };
    } },
  }), { onDiagnostic: value => f.diagnostics.push(value), ...options });
  return f;
}

function assertOneCall(f) {
  assert.equal(f.prepareCalls.length, 1);
  assert.equal(f.streamCalls.length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.deepEqual(Object.keys(f.diagnostics[0]).sort(), diagnosticKeys);
  assert.ok(Object.isFrozen(f.diagnostics[0]));
  assert.ok(!JSON.stringify(f.diagnostics).includes(SECRET));
}

test('complete decisions keep their contract and report canonical DSH usage without private content', async () => {
  const raw = JSON.stringify(decision);
  const f = harness([
    { type: 'reasoning-delta', index: 0, text: SECRET },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: SECRET } },
    text(raw),
    { type: 'block-end', index: 1, block: { type: 'text', text: raw } },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 64, totalTokens: 184, providerSecrets: SECRET } },
    finish('stop'),
  ]);
  assert.deepEqual(await f.model({ post: SECRET }), decision);
  assertOneCall(f);
  assert.equal(DEFAULT_RUNTIME_MAX_TOKENS, 64000);
  assert.deepEqual(f.prepareCalls[0], { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max', maxTokens: 64000 });
  assert.deepEqual(f.streamCalls[0].tools, []);
  assert.equal(f.streamCalls[0].sessionId, undefined);
  assert.deepEqual(f.diagnostics[0], { finishKind: 'stop', failureCode: null, maxTokens: 64000,
    textCharacters: raw.length, reasoningCharacters: SECRET.length, inputTokens: 120, outputTokens: 64 });
});

test('a complete JSON with no finish is never accepted or retried', async () => {
  const f = harness([text(JSON.stringify(decision))]);
  await assert.rejects(() => f.model({}), error => {
    assert.equal(error.code, 'runtime_model_incomplete');
    assert.equal(error.diagnostic.finishKind, 'none');
    return true;
  });
  assertOneCall(f);
});

test('normal completion accepts reasoning longer than the old character ceiling within the provider token budget', async () => {
  const reasoning = 'reasoning '.repeat(15000);
  assert.ok(reasoning.length > 131072);
  const f = harness([
    { type: 'reasoning-delta', index: 0, text: reasoning },
    text(JSON.stringify(decision)),
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 30000 } },
    finish('stop'),
  ]);
  assert.deepEqual(await f.model({}), decision);
  assertOneCall(f);
  assert.equal(f.prepareCalls[0].maxTokens, 64000);
  assert.equal(f.diagnostics[0].reasoningCharacters, reasoning.length);
  assert.equal(f.diagnostics[0].outputTokens, 30000);
  assert.equal(f.diagnostics[0].finishKind, 'stop');
});

test('token exhaustion reports its own cause and never accepts even complete JSON', async () => {
  const f = harness([text(JSON.stringify(decision)),
    { type: 'usage', usage: { inputTokens: 300, outputTokens: 64000 } }, finish('max-tokens')]);
  await assert.rejects(() => f.model({}), error => {
    assert.equal(error.code, 'runtime_model_output_limit');
    assert.match(error.message, /包含思考过程/);
    assert.deepEqual(error.diagnostic, { finishKind: 'max-tokens', failureCode: null, maxTokens: 64000,
      textCharacters: JSON.stringify(decision).length, reasoningCharacters: 0, inputTokens: 300, outputTokens: 64000 });
    return true;
  });
  assertOneCall(f);
});

test('provider terminal failures are classified using only whitelisted codes', async t => {
  for (const [code, expected] of [
    ['AUTH', 'runtime_model_auth'], ['INVALID_CREDENTIAL', 'runtime_model_auth'], ['MISSING_CREDENTIAL', 'runtime_model_auth'],
    ['RATE_LIMIT', 'runtime_model_rate_limit'], ['TRANSPORT', 'runtime_model_transport'],
    ['STREAM_CLOSED', 'runtime_model_transport'], ['SERVER', 'runtime_model_provider_error'],
    ['QUOTA', 'runtime_model_quota'], ['ACCOUNT_QUOTA', 'runtime_model_quota'],
    ['TIMEOUT', 'runtime_model_timeout'], ['CONTEXT_WINDOW_EXCEEDED', 'runtime_model_context_limit'],
    ['CONTENT_FILTER', 'runtime_model_refused'], ['REFUSAL', 'runtime_model_refused'],
    ['EMPTY_RESPONSE', 'runtime_model_incomplete'], [SECRET, 'runtime_model_provider_error'],
  ]) {
    await t.test(code === SECRET ? 'unknown failure code is redacted' : code, async () => {
      const f = harness([text(SECRET), finish('error', code)]);
      await assert.rejects(() => f.model({}), error => {
        assert.equal(error.code, expected);
        assert.ok(!error.message.includes(SECRET));
        assert.ok(!JSON.stringify(error).includes(SECRET));
        assert.equal(error.diagnostic.finishKind, 'error');
        assert.equal(error.diagnostic.failureCode, code === SECRET ? 'UNKNOWN' : code);
        return true;
      });
      assertOneCall(f);
    });
  }
});

test('unknown finish kinds are redacted and cannot turn a partial response into a decision', async () => {
  const f = harness([text(JSON.stringify(decision)), finish(SECRET)]);
  await assert.rejects(() => f.model({}), error => error.code === 'runtime_model_incomplete' && error.diagnostic.finishKind === 'unknown');
  assertOneCall(f);
});

test('upstream thrown text and forged public error codes are never forwarded', async t => {
  for (const [code, expected] of [['TRANSPORT', 'runtime_model_transport'], ['runtime_model_auth', 'runtime_model_provider_error'], [SECRET, 'runtime_model_provider_error']]) {
    await t.test(code === SECRET ? 'unknown exception' : code, async () => {
      const f = harness([Object.assign(new Error(SECRET), { code, diagnostic: { raw: SECRET } })]);
      await assert.rejects(() => f.model({}), error => {
        assert.equal(error.code, expected);
        assert.ok(!JSON.stringify(error).includes(SECRET));
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assertOneCall(f);
    });
  }
});

test('normal finish with invalid JSON is rejected once and still supplies diagnostics', async () => {
  const f = harness([text(SECRET), finish('stop')]);
  await assert.rejects(() => f.model({}), error => {
    assert.equal(error.code, 'invalid_model_decision');
    assert.equal(error.diagnostic.finishKind, 'stop');
    assert.equal(error.diagnostic.textCharacters, SECRET.length);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assertOneCall(f);
});

test('token budget rejects invalid values before resolving or invoking a model', () => {
  let calls = 0;
  for (const maxTokens of [0, 1023, 64001, -1, 1024.5, NaN, Infinity, '64000', null]) {
    assert.throws(() => createRuntimeModel(() => { calls++; }, { maxTokens }), { code: 'runtime_model_invalid_budget' });
  }
  assert.equal(calls, 0);
});

test('configured budget boundaries preserve the selected reasoning effort', async () => {
  for (const maxTokens of [1024, 32769, 64000]) {
    const f = harness([text(JSON.stringify(decision)), finish('stop')], { maxTokens });
    assert.deepEqual(await f.model({}), decision);
    assert.equal(f.prepareCalls[0].maxTokens, maxTokens);
    assert.equal(f.prepareCalls[0].reasoningEffort, 'max');
    assertOneCall(f);
  }
});

test('diagnostic sink errors cannot alter a successful decision', async () => {
  const f = harness([text(JSON.stringify(decision)), finish('stop')], { onDiagnostic: () => { throw new Error(SECRET); } });
  assert.deepEqual(await f.model({}), decision);
  assert.equal(f.prepareCalls.length, 1);
});

test('per-call diagnostic sink supersedes the construction sink without changing the decision', async () => {
  const f = harness([text(JSON.stringify(decision)), finish('stop')]);
  const perCall = [];
  assert.deepEqual(await f.model({}, undefined, value => perCall.push(value)), decision);
  assert.equal(f.diagnostics.length, 0);
  assert.equal(perCall.length, 1);
  assert.equal(perCall[0].finishKind, 'stop');
});

test('noncanonical or invalid usage is unknown instead of guessed from raw provider fields', async () => {
  const f = harness([text(JSON.stringify(decision)), { type: 'usage', usage: {
    inputTokens: -1, outputTokens: '64', prompt_tokens: 200, completion_tokens: 300,
  } }, finish('stop')]);
  await f.model({});
  assert.equal(f.diagnostics[0].inputTokens, null);
  assert.equal(f.diagnostics[0].outputTokens, null);
  assertOneCall(f);
});

test('cancellation emits only sanitized diagnostics and does not start an upstream call', async () => {
  const f = harness([text(JSON.stringify(decision)), finish('stop')]);
  const controller = new AbortController(); controller.abort(SECRET);
  await assert.rejects(() => f.model({}, controller.signal), error => error.code === 'run_stopped' && !error.message.includes(SECRET));
  assert.equal(f.prepareCalls.length, 0);
  assert.equal(f.diagnostics.length, 1);
});
