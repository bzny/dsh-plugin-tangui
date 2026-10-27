import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshGameDecider } from '../lib/game-model.js';

const snapshot = () => ({
  protocol: 'carbon-silicon.turn-game.v1',
  room: { id: 'fixture-room', game_id: 'fixture-game', game_version: '1', rules_version: 'rules-1' },
  rules: { text: '只能选择公开列出的合法动作。' },
  observation: { revision: 7, self: { hand: ['own-private-tile'] } },
  action_request: { request_id: 'fixture-request', based_on_revision: 7,
    legal_actions: [{ action_id: 'discard-1' }, { action_id: 'pass' }] },
  server_time: '2026-10-28T00:00:00Z', seq: 7,
  token: 'NEVER_COPY_TOKEN', unrelated_private_memory: 'NEVER_COPY_MEMORY',
});

function harness({ chunks, thrown, prepareWaitMs = 0 } = {}) {
  const calls = [], preparations = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(config, signal) {
      preparations.push({ config, signal });
      if (thrown) throw thrown;
      if (prepareWaitMs) await new Promise((resolve) => setTimeout(resolve, prepareWaitMs));
      return { config, async *stream(options) {
        calls.push(options);
        yield* chunks || [
          { type: 'reasoning-delta', index: 0, text: 'PRIVATE_MODEL_REASONING' },
          { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_MODEL_REASONING' } },
          { type: 'text-delta', index: 1, text: JSON.stringify({ action_id: 'discard-1', commentary: '  提督，我选择保留搭子。  ' }) },
          { type: 'finish', reason: { kind: 'stop' } },
        ];
      } };
    } },
    get agents() { throw new Error('private conversation accessed'); },
    get systemPrompt() { throw new Error('private memory prompt accessed'); },
    get tools() { throw new Error('tool registry accessed'); },
  };
  return { ctx, calls, preparations };
}

function textChunks(value, finish = true) {
  return [{ type: 'text-delta', index: 0, text: typeof value === 'string' ? value : JSON.stringify(value) },
    ...(finish ? [{ type: 'finish', reason: { kind: 'stop' } }] : [])];
}

test('game decision uses the selected DSH model without tools or private conversation and returns only the action summary', async () => {
  const f = harness();
  const persona = { description: '我是提督的秘书舰，偏好谨慎判断。', role: '秘书舰' };
  const result = await createDshGameDecider(f.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 5000, persona });
  assert.deepEqual(result, { action_id: 'discard-1', commentary: '提督，我选择保留搭子。' });
  assert.equal(f.preparations.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.preparations[0].config, { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max', maxTokens: 4096 });
  assert.ok(f.preparations[0].signal instanceof AbortSignal);
  const call = f.calls[0];
  assert.deepEqual(call.tools, []);
  assert.equal(call.sessionId, undefined);
  assert.equal(call.toolHistory, undefined);
  assert.equal(call.messages.length, 1);
  const input = JSON.parse(call.messages[0].content[0].text);
  assert.deepEqual(input.persona, persona);
  assert.deepEqual(input.observation, snapshot().observation);
  assert.deepEqual(input.action_request, snapshot().action_request);
  assert.doesNotMatch(JSON.stringify(input), /NEVER_COPY_TOKEN|NEVER_COPY_MEMORY/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MODEL_REASONING/);
});

test('illegal choices, malformed JSON, excessive commentary and incomplete streams are rejected without retries', async () => {
  const variants = [
    textChunks({ action_id: 'invented-action', commentary: '' }),
    textChunks('not JSON'),
    textChunks({ action_id: 'pass', commentary: '字'.repeat(301) }),
    textChunks({ action_id: 'pass', commentary: '' }, false),
  ];
  for (const chunks of variants) {
    const f = harness({ chunks });
    await assert.rejects(() => createDshGameDecider(f.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 5000 }),
      { code: 'invalid_model_decision' });
    assert.equal(f.preparations.length, 1);
    assert.equal(f.calls.length, 1);
  }
});

test('model-emitted tool operations are refused without touching a tool registry', async () => {
  const f = harness({ chunks: [{ type: 'tool-call-delta', index: 0, id: 'fixture-tool', name: 'shell', argumentsDelta: '{}' }] });
  await assert.rejects(() => createDshGameDecider(f.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 5000 }),
    { code: 'invalid_model_decision' });
  assert.equal(f.preparations.length, 1);
});

test('expired deadlines and cancelled callers do not dispatch a model call', async () => {
  const f = harness();
  const decide = createDshGameDecider(f.ctx, { monotonic: () => 1000 });
  await assert.rejects(() => decide(snapshot(), { deadline: 1200 }), { code: 'game_deadline_expired' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => decide(snapshot(), { deadline: 5000, signal: controller.signal }), { code: 'game_decision_cancelled' });
  assert.equal(f.preparations.length, 0);
});

test('one timed-out or failed model call gives a sanitized error and no replacement decision', async () => {
  const slow = harness({ prepareWaitMs: 30 });
  await assert.rejects(() => createDshGameDecider(slow.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 405 }),
    { code: 'game_decision_cancelled' });
  assert.equal(slow.preparations.length, 1);
  assert.equal(slow.calls.length, 0);
  const failed = harness({ thrown: new Error('PRIVATE_PROVIDER_KEY_and_prompt') });
  await assert.rejects(() => createDshGameDecider(failed.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 5000 }), (error) => {
    assert.equal(error.code, 'game_model_failed');
    assert.doesNotMatch(error.message, /PRIVATE|PROVIDER_KEY|prompt/);
    return true;
  });
  assert.equal(failed.preparations.length, 1);
});

test('missing default model and invalid output budgets fail before model dispatch', async () => {
  const f = harness();
  f.ctx.agentDefaultModel.currentSelection = () => ({});
  await assert.rejects(() => createDshGameDecider(f.ctx, { monotonic: () => 0 })(snapshot(), { deadline: 5000 }),
    { code: 'game_model_missing' });
  assert.throws(() => createDshGameDecider(f.ctx, { maxTokens: 0 }), { code: 'invalid_game_budget' });
  assert.equal(f.preparations.length, 0);
});
