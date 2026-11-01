import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_LIFE_PROMPT, parseGameLife, applyLifeResult, newLife } from '../lib/companion-life.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createModelCallLogger } from '../lib/model-call-log.js';
import { retryInstruction, validationDetails } from '../lib/model-retry.js';

// Synthetic public facts only; never commit the user's raw failure samples.
const publicRecord = { view: { last_round: { pingju: { fenpei: [-1000, -1000, -1000, 3000], name: '荒牌平局', shoupai: ['', '', '', 'public-hand'] } } }, result: null };
const excerpt = '"fenpei":[-1000,-1000,-1000,3000],"name":"荒牌平局"';
const context = { phase: 'reflection', room_id: 'room-fixture', self: { id: 'self' }, choices: [],
  participants: [{ actor_id: 'self' }, { actor_id: 'other' }], evidence: [{ evidence_id: 'room:fixture:public', public_record: publicRecord }] };
const impression = patch => ({ actor_id: 'other', impression: '本场最后一次流局获得听牌分。', evidence_id: 'room:fixture:public', evidence_excerpt: excerpt, ...patch });
const output = patch => ({ reflection: '本桌提前结束，没有正式成绩。', state: { mood: 52, interest: 55, pressure: 45 }, baseline: null,
  goal: '下次仔细看公开动作', note: '先休息', impressions: [impression()], next_activity: 'rest', choice_index: 0, draft: null, rest_minutes: 120, ...patch });
const appraisal = patch => ({ summary: '想休息', reflection: '本场值得回顾', delta: { mood: 2, pressure: -2, energy: -4 },
  activities: { observe: 55, play: 45, rest: 65 }, growth: null, contact: null, ...patch });
const malformed = '{"reflection":"PRIVATE_BAD_JSON","impressions":[{"evidence_excerpt":"points":123}]}';
const stitched = '"pingju":{"fenpei":[-1000,-1000,-1000,3000],"name":"荒牌平局"}';
const detail = (reason, field = null) => error => {
  assert.deepEqual(validationDetails(error), { validation_reason: reason, validation_field: field });
  return true;
};

test('baseline null is valid and keeps an established baseline unchanged', () => {
  const life = newLife(0); life.baseline = { mood: 55, interest: 65, pressure: 35 }; life.baseline_source = 'persona_interpretation';
  const applied = applyLifeResult(life, parseGameLife(JSON.stringify(output())), context, 1000);
  assert.deepEqual(applied.life.baseline, life.baseline);
  assert.deepEqual(applied.life.values, output().state);
  assert.deepEqual(life.values, { mood: 50, interest: 50, pressure: 50 });
});

test('malformed JSON reports syntax, not a generic schema failure or raw model text', () => {
  assert.throws(() => parseGameLife(malformed), error => {
    detail('json_syntax')(error); assert.doesNotMatch(error.message, /PRIVATE_BAD_JSON|points/); return true;
  });
});

for (const field of ['growth', 'contact', 'profile']) test(`appraisal.${field} strings remain invalid and identify the precise field`, () => {
  assert.throws(() => parseGameLife(JSON.stringify(output({ appraisal: appraisal({ [field]: 'PRIVATE_FREEFORM_VALUE' }) }))), detail('field_type', `appraisal.${field}`));
});

test('structured optional appraisal fields and null are both accepted without reinterpretation', () => {
  for (const value of [null, appraisal(), appraisal({ growth: { trait: 'deliberation', direction: 1, reason: '多次真实经历中的有限观察' }, contact: { text: '今天想分享这场经历', reason: '有具体的新经历' } })]) {
    const result = parseGameLife(JSON.stringify(output({ appraisal: value })));
    assert.deepEqual(result.appraisal, value);
  }
});

test('impression evidence must be a continuous source excerpt, not reconstructed partial JSON', () => {
  assert.equal(JSON.stringify(publicRecord).includes(stitched), false);
  const life = newLife(0), before = structuredClone(life);
  assert.throws(() => applyLifeResult(life, output({ impressions: [impression({ evidence_excerpt: stitched })] }), context, 1000), detail('invalid_evidence', 'impressions.evidence_excerpt'));
  assert.deepEqual(life, before);
  assert.throws(() => applyLifeResult(life, output({ impressions: [impression({ evidence_excerpt: excerpt.replace('3000', '4000') })] }), context, 1000), detail('invalid_evidence', 'impressions.evidence_excerpt'));
  const fixed = applyLifeResult(life, output(), context, 1000);
  assert.equal(fixed.life.impressions[0].evidence_excerpt, excerpt);
});

test('unknown people, other-room evidence, game choices and baseline resets retain their checks', () => {
  for (const actor_id of ['self', 'outsider']) assert.throws(() => applyLifeResult(newLife(0), output({ impressions: [impression({ actor_id })] }), context, 0), detail('invalid_evidence', 'impressions.actor_id'));
  assert.throws(() => applyLifeResult(newLife(0), output({ impressions: [impression({ evidence_id: 'other-room' })] }), context, 0), detail('invalid_evidence', 'impressions.evidence_id'));
  assert.throws(() => applyLifeResult(newLife(0), output({ next_activity: 'continue' }), context, 0), detail('invalid_choice', 'choice_index'));
  const life = newLife(0); life.baseline_source = 'persona_interpretation';
  assert.throws(() => applyLifeResult(life, output({ baseline: { mood: 10, interest: 10, pressure: 10 } }), context, 0), detail('invalid_choice', 'baseline'));
});

test('field diagnostics only contain known field names', () => {
  assert.throws(() => parseGameLife(JSON.stringify(output({ PRIVATE_FIELD_NAME: 'PRIVATE_VALUE' }))), detail('unknown_field'));
  assert.throws(() => parseGameLife(JSON.stringify(output({ state: { mood: 101, interest: 50, pressure: 50 } }))), detail('schema_invalid', 'state'));
  assert.throws(() => parseGameLife(JSON.stringify(output({ rest_minutes: 0 }))), detail('schema_invalid', 'rest_minutes'));
  assert.deepEqual(validationDetails({ validation_reason: 'schema_invalid', validation_field: 'appraisal.PRIVATE_FIELD_NAME' }), { validation_reason: 'schema_invalid', validation_field: null });
});

test('prompt and retry hints explain optional objects, continuous evidence and JSON escaping', () => {
  assert.match(GAME_LIFE_PROMPT, /baseline=null/);
  assert.match(GAME_LIFE_PROMPT, /appraisal\.growth.*direction/);
  assert.match(GAME_LIFE_PROMPT, /appraisal\.contact.*reason/);
  assert.match(retryInstruction({ validation_reason: 'json_syntax' }), /只编码一层/);
  assert.match(retryInstruction({ validation_reason: 'field_type', validation_field: 'appraisal.growth' }), /contact.*text.*reason/);
  assert.match(retryInstruction({ validation_reason: 'invalid_evidence', validation_field: 'impressions.evidence_excerpt' }), /不必构成完整JSON/);
  assert.doesNotMatch(retryInstruction({ validation_reason: 'invalid_evidence', validation_field: 'overrides' }), /同桌|participants|impressions/);
  assert.doesNotMatch(retryInstruction({ validation_reason: 'field_type', validation_field: 'appraisal.contact' }), /不包含event_ids|goal/);
});

test('budgeted retries receive specific safe hints, keep the chosen model and save only a valid result', async () => {
  const responses = [malformed, JSON.stringify(output({ appraisal: appraisal({ growth: 'PRIVATE_GROWTH', contact: 'PRIVATE_CONTACT' }) })), JSON.stringify(output())];
  const requests = [], configurations = [], logs = [], reserved = [], validated = [];
  const logger = createModelCallLogger({ directory: 'unused-test-directory', makeDirectory() {},
    append(path, line) { logs.push(JSON.parse(line)); }, setTimer: () => null, clearTimer() {} });
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'selected-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(config) {
      configurations.push(config); const text = responses[configurations.length - 1];
      return { config, async *stream(request) { requests.push(request); yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    } } };
  const model = createRuntimeModel(() => ctx, { purpose: 'game_reflection', systemPrompt: GAME_LIFE_PROMPT, parse: parseGameLife, callLogger: logger, retryDelays: [0, 0] });
  const result = await model(context, new AbortController().signal, undefined, undefined, {
    beforeRetry: async ({ attempt }) => reserved.push(attempt),
    validateOutput: value => validated.push(applyLifeResult(newLife(0), value, context, 0)),
  });
  assert.deepEqual(result, output()); assert.deepEqual(reserved, [2, 3]); assert.equal(validated.length, 1);
  assert.equal(configurations.length, 3);
  assert.ok(configurations.every(c => c.provider === 'fixture' && c.model === 'selected-model' && c.reasoningEffort === 'max' && c.maxTokens === 64000));
  assert.match(requests[1].system, /json_syntax/); assert.match(requests[2].system, /appraisal\.growth/);
  const finished = logs.filter(row => row.event === 'finished');
  assert.deepEqual(finished.map(row => [row.validation_reason, row.validation_field]), [['json_syntax', null], ['field_type', 'appraisal.growth'], [null, null]]);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|本桌提前结束|fenpei/);
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_BAD_JSON|PRIVATE_GROWTH|PRIVATE_CONTACT/);
});
