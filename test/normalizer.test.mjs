import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshNormalizer, currentModelName, DEFAULT_NORMALIZATION_TIMEOUT_MS, DEFAULT_NORMALIZATION_MAX_TOKENS } from '../lib/dsh-normalizer.js';
import { parseNormalizedPersona, PERSONA_FIELDS } from '../lib/persona-normalization.js';

const description = '  我是岛风酱，是提督的秘书舰。我叫用户「提督」。语气活泼但做事认真。喜欢麻将。\n';
const output = () => ({ name: { value: '岛风酱', evidence: '我是岛风酱' }, overrides: {
  ...Object.fromEntries(PERSONA_FIELDS.map((key) => [key, null])),
  role: { value: '秘书舰', evidence: '是提督的秘书舰' },
  manager_address: { value: '提督', evidence: '我叫用户「提督」' },
  speaking_style: { value: '活泼、认真', evidence: '语气活泼但做事认真' },
  interests: { value: '麻将', evidence: '喜欢麻将' },
} });

function harness({ chunks, thrown, waitMs = 0, streamWaitMs = 0 } = {}) {
  const calls = [];
  let preparations = 0;
  const ctx = {
    agentDefaultModel: { currentSelection() { return { provider: 'configured-provider', model: 'configured-model', reasoningEffort: 'max' }; } },
    llm: { async prepareCall(config, signal) {
      preparations++;
      assert.equal(signal instanceof AbortSignal, true);
      if (thrown) throw thrown;
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return { config, async *stream(options) {
        calls.push(options);
        for (const chunk of chunks || [
          { type: 'text-delta', index: 0, text: JSON.stringify(output()) },
          { type: 'finish', reason: { kind: 'stop' } },
        ]) {
          yield chunk;
          if (streamWaitMs) await new Promise((resolve) => setTimeout(resolve, streamWaitMs));
        }
      } };
    } },
    // These would leak private state or execute tools if the adapter touched them.
    get agents() { throw new Error('private conversation accessed'); },
    get systemPrompt() { throw new Error('private memory prompt accessed'); },
    get tools() { throw new Error('tool registry accessed'); },
  };
  return { ctx, calls, count: () => preparations };
}

test('normalizes free prose with grounded evidence and preserves exact description', async () => {
  const f = harness();
  const value = await createDshNormalizer(f.ctx)({ description });
  assert.equal(value.name, '岛风酱');
  assert.equal(value.description, description);
  assert.equal(value.overrides.manager_address, '提督');
  assert.equal(value.normalization.model, 'configured-model');
  assert.equal(value.normalization.evidence.interests, '喜欢麻将');
  assert.equal(f.count(), 1); assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.deepEqual(request.tools, []);
  assert.equal(request.sessionId, undefined); assert.equal(request.toolHistory, undefined);
  assert.equal(request.messages.length, 1);
  const input = JSON.parse(request.messages[0].content[0].text);
  assert.equal(input.persona_source, description);
  assert.deepEqual(Object.keys(input), ['task', 'persona_source']);
  assert.equal(request.reasoningEffort, 'max');
  assert.equal(request.maxTokens, 8192);
  assert.equal(DEFAULT_NORMALIZATION_TIMEOUT_MS, 180000);
  assert.equal(DEFAULT_NORMALIZATION_MAX_TOKENS, 8192);
  assert.equal(currentModelName(f.ctx), 'configured-model');
});

test('missing name, fabricated evidence, extra identity and token fields are rejected', () => {
  const noName = output(); noName.name = null;
  assert.throws(() => parseNormalizedPersona(JSON.stringify(noName), description, 'model'), { code: 'normalization_name_missing' });
  const fakeEvidence = output(); fakeEvidence.overrides.role.evidence = '未出现的原文';
  assert.throws(() => parseNormalizedPersona(JSON.stringify(fakeEvidence), description, 'model'), { code: 'normalization_evidence_invalid' });
  const inventedName = output(); inventedName.name.value = '从未写过的名字';
  assert.throws(() => parseNormalizedPersona(JSON.stringify(inventedName), description, 'model'), { code: 'normalization_name_missing' });
  for (const key of ['actor_id', 'token', 'url', 'description']) {
    const extra = { ...output(), [key]: 'unwanted-data' };
    assert.throws(() => parseNormalizedPersona(JSON.stringify(extra), description, 'model'), { code: 'normalization_schema_invalid' });
  }
});

test('malformed JSON is not retried or interpreted as a valid persona', async () => {
  const f = harness({ chunks: [{ type: 'text-delta', index: 0, text: 'not JSON' }, { type: 'finish', reason: { kind: 'stop' } }] });
  await assert.rejects(() => createDshNormalizer(f.ctx)({ description }), (error) => {
    assert.equal(error.code, 'normalization_json_invalid');
    assert.deepEqual(error.diagnostic, { textChars: 8, reasoningChars: 0, textBlocks: 1, reasoningBlocks: 0, finishKind: 'stop', wholeJsonFence: false });
    return true;
  });
  assert.equal(f.count(), 1);
});

test('diagnostic uses only counts, a boolean and a closed finish enum without raw output', async () => {
  const raw = '```json\nSECRET_PRIVATE_OUTPUT\n```';
  const reasoning = 'PRIVATE_REASONING';
  const f = harness({ chunks: [
    { type: 'reasoning-delta', index: 0, text: reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    { type: 'text-delta', index: 1, text: raw },
    { type: 'block-end', index: 1, block: { type: 'text', text: raw } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] });
  await assert.rejects(() => createDshNormalizer(f.ctx)({ description }), (error) => {
    assert.equal(error.code, 'normalization_json_invalid');
    assert.deepEqual(error.diagnostic, { textChars: raw.length, reasoningChars: reasoning.length,
      textBlocks: 1, reasoningBlocks: 1, finishKind: 'stop', wholeJsonFence: true });
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /SECRET|PRIVATE|OUTPUT/);
    assert.equal(Object.values(error.diagnostic).every((value) => typeof value === 'number' || typeof value === 'boolean' || value === 'stop'), true);
    return true;
  });
  assert.equal(f.count(), 1);
});

test('timeout includes partial stream counts but never partial text or reasoning', async () => {
  const reasoning = 'PRIVATE_PARTIAL_REASONING';
  const f = harness({ streamWaitMs: 40, chunks: [{ type: 'reasoning-delta', index: 0, text: reasoning }] });
  await assert.rejects(() => createDshNormalizer(f.ctx, { timeoutMs: 5 })({ description }), (error) => {
    assert.equal(error.code, 'normalization_timeout');
    assert.deepEqual(error.diagnostic, { textChars: 0, reasoningChars: reasoning.length,
      textBlocks: 0, reasoningBlocks: 1, finishKind: 'none', wholeJsonFence: false });
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE/);
    return true;
  });
  assert.equal(f.count(), 1);
});

test('one JSON code fence is accepted but empty output and surrounding prose are not', () => {
  const json = JSON.stringify(output());
  assert.equal(parseNormalizedPersona('```json\n' + json + '\n```', description, 'model').name, '岛风酱');
  assert.throws(() => parseNormalizedPersona('  ', description, 'model'), { code: 'normalization_empty_output' });
  assert.throws(() => parseNormalizedPersona('Here is your persona:\n' + json, description, 'model'), { code: 'normalization_json_invalid' });
});

test('one missing outer brace is tolerated only when all required fields and evidence are complete', () => {
  const json = JSON.stringify(output());
  const expected = parseNormalizedPersona(json, description, 'model');
  assert.deepEqual(parseNormalizedPersona(json.slice(0, -1), description, 'model'), expected);
  assert.throws(() => parseNormalizedPersona(json.slice(0, -2), description, 'model'), { code: 'normalization_json_invalid' });
  const incomplete = output(); delete incomplete.overrides.memory_notes;
  assert.throws(() => parseNormalizedPersona(JSON.stringify(incomplete).slice(0, -1), description, 'model'), { code: 'normalization_schema_invalid' });
  const badEvidence = output(); badEvidence.overrides.role.evidence = 'not in source';
  assert.throws(() => parseNormalizedPersona(JSON.stringify(badEvidence).slice(0, -1), description, 'model'), { code: 'normalization_evidence_invalid' });
});

test('tool output and incomplete streams are refused without tool execution', async () => {
  const tool = harness({ chunks: [{ type: 'tool-call-delta', index: 0, id: 'tool-1', name: 'shell', argumentsDelta: '{}' }] });
  await assert.rejects(() => createDshNormalizer(tool.ctx)({ description }), { code: 'normalization_tool_output' });
  const unfinished = harness({ chunks: [{ type: 'text-delta', index: 0, text: JSON.stringify(output()) }] });
  await assert.rejects(() => createDshNormalizer(unfinished.ctx)({ description }), { code: 'normalization_incomplete' });
  assert.equal(tool.count(), 1); assert.equal(unfinished.count(), 1);
});

test('upstream failure and timeout reveal no raw error or credential and perform one attempt', async () => {
  const f = harness({ thrown: new Error('SECRET_API_KEY_and_private_user_text') });
  await assert.rejects(() => createDshNormalizer(f.ctx)({ description }), (error) => {
    assert.equal(error.code, 'normalization_model_failed');
    assert.doesNotMatch(error.message, /SECRET|private_user/); return true;
  });
  assert.equal(f.count(), 1);
  const slow = harness({ waitMs: 40 });
  await assert.rejects(() => createDshNormalizer(slow.ctx, { timeoutMs: 5 })({ description }), { code: 'normalization_timeout' });
  assert.equal(slow.count(), 1); assert.equal(slow.calls.length, 0);
});

test('empty input and absent DSH default model fail before dispatch', async () => {
  const f = harness();
  await assert.rejects(() => createDshNormalizer(f.ctx)({ description: '' }), { code: 'normalization_input_invalid' });
  f.ctx.agentDefaultModel.currentSelection = () => ({});
  await assert.rejects(() => createDshNormalizer(f.ctx)({ description }), { code: 'normalization_model_missing' });
  assert.equal(f.count(), 0);
});
