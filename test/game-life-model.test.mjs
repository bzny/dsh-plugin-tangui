import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createModelCallLogger } from '../lib/model-call-log.js';
import { GAME_LIFE_PROMPT, parseGameLife } from '../lib/companion-life.js';

test('life model uses one configured 64000-token call and logs purpose without private thoughts', async () => {
  const calls = [], log = [], preparations = [];
  const result = { reflection: '私人赛后回想', state: { mood: 61, interest: 72, pressure: 43 }, baseline: null,
    goal: '继续练习', note: '稍有压力也有兴致', impressions: [], next_activity: 'rest', choice_index: 0, draft: null };
  const logger = createModelCallLogger({ directory: 'unused-test-directory', makeDirectory() {},
    append(path, line) { log.push(JSON.parse(line)); }, setTimer: () => null, clearTimer() {} });
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'selected-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(config) { preparations.push(config); return { config, async *stream(options) {
      calls.push(options); yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_INTERNAL_REASONING' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_INTERNAL_REASONING' } };
      yield { type: 'text-delta', index: 1, text: JSON.stringify(result) }; yield { type: 'finish', reason: { kind: 'stop' } };
    } }; } } };
  const model = createRuntimeModel(() => ctx, { purpose: 'game_reflection', systemPrompt: GAME_LIFE_PROMPT, parse: parseGameLife, callLogger: logger });
  const actual = await model({ phase: 'reflection', room_id: 'room-fixture', persona: { description: 'PRIVATE_PERSONA' } }, new AbortController().signal);
  assert.deepEqual(actual, result); assert.equal(calls.length, 1);
  assert.deepEqual(preparations[0], { provider: 'fixture', model: 'selected-model', maxTokens: 64000, reasoningEffort: 'max' });
  assert.deepEqual(calls[0].tools, []); assert.equal(log.filter(row => row.event === 'finished').length, 1);
  assert.ok(log.every(row => row.purpose === 'game_reflection'));
  assert.doesNotMatch(JSON.stringify(log), /PRIVATE_|私人赛后回想|稍有压力/);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_INTERNAL_REASONING/);
});
