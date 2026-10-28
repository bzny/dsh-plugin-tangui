import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginModelCall, createModelCallLogger } from '../lib/model-call-log.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createDshNormalizer } from '../lib/dsh-normalizer.js';
import { createDshGameDecider } from '../lib/game-model.js';
import { PERSONA_FIELDS } from '../lib/persona-normalization.js';

const PRIVATE_TEXT = 'PRIVATE_POST_AND_REASONING';
const PRIVATE_KEY = 'sk-PRIVATE_FIXTURE_KEY';
const PRIVATE_URL = `https://private.example/v1?api_key=${PRIVATE_KEY}`;
const RAW_ERROR = `PRIVATE_UPSTREAM_ERROR ${PRIVATE_URL}`;
const FIELDS = ['time', 'call_id', 'client', 'purpose', 'event', 'phase', 'model', 'provider', 'max_tokens',
  'timeout_ms', 'timeout_kind', 'deadline_remaining_ms', 'elapsed_ms', 'first_output_ms', 'text_characters', 'reasoning_characters',
  'input_tokens', 'output_tokens', 'finish_kind', 'error_code'].sort();
const metadata = { purpose: 'community_reply', model: 'fixture-model', provider: 'fixture-provider', maxTokens: 64000, timeoutMs: 180000 };
const delta = (text, index = 1, kind = 'text') => ({ type: `${kind}-delta`, index, text });
const finish = (kind = 'stop', code) => ({ type: 'finish', reason: { kind,
  ...(code === undefined ? {} : { failure: { code, message: RAW_ERROR, raw: PRIVATE_TEXT } }) } });

function recorder(overrides = {}) {
  const f = { entries: [], paths: [], intervals: [], cleared: [], time: 0, wall: Date.parse('2026-10-28T00:00:00Z') };
  f.logger = createModelCallLogger({ directory: 'unused-fixture-directory', now: () => f.wall,
    monotonic: () => f.time, setTimer(callback, ms) { f.intervals.push({ callback, ms }); return f.intervals.length; },
    clearTimer(timer) { f.cleared.push(timer); }, makeDirectory() {},
    append(path, line) { f.paths.push(path); f.entries.push(JSON.parse(line)); }, ...overrides });
  return f;
}

function assertSafe(entries) {
  for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), FIELDS);
  const serialized = JSON.stringify(entries);
  for (const secret of [PRIVATE_TEXT, PRIVATE_KEY, PRIVATE_URL, RAW_ERROR]) assert.ok(!serialized.includes(secret));
}

function isolatedDirectory(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'model-call-log-'));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${root}${sep}`) && target !== root);
    rmSync(target, { recursive: true });
  });
  return directory;
}

test('daily JSONL has only fixed fields, retains numeric counts and survives logger restart', t => {
  const directory = isolatedDirectory(t);
  let wall = Date.parse('2026-10-28T23:59:59Z');
  const logger = createModelCallLogger({ directory, now: () => wall, monotonic: () => 0,
    setTimer: () => null, clearTimer() {} });
  const call = logger.start({ ...metadata, model: PRIVATE_URL, provider: PRIVATE_URL, raw: RAW_ERROR, token: PRIVATE_KEY });
  call.dispatched();
  call.observe(delta(PRIVATE_TEXT));
  call.observe({ type: 'usage', usage: { inputTokens: 120, outputTokens: 55, raw: RAW_ERROR, key: PRIVATE_KEY } });
  call.observe(finish('error', RAW_ERROR));
  wall += 2000;
  call.finish({ code: RAW_ERROR, raw: RAW_ERROR });
  assert.deepEqual(readdirSync(directory).sort(), ['2026-10-28.jsonl', '2026-10-29.jsonl']);
  const entries = readdirSync(directory).sort().flatMap(file => readFileSync(join(directory, file), 'utf8').trim().split('\n').map(JSON.parse));
  assertSafe(entries);
  assert.equal(new Set(entries.map(entry => entry.call_id)).size, 1);
  assert.equal(entries.at(-1).text_characters, PRIVATE_TEXT.length);
  assert.equal(entries.at(-1).input_tokens, 120);
  assert.equal(entries.at(-1).output_tokens, 55);
  assert.equal(entries.at(-1).error_code, 'UNKNOWN');
  assert.equal(entries.at(-1).deadline_remaining_ms, null);
  for (const entry of entries) { assert.equal(entry.model, null); assert.equal(entry.provider, null); }
  assert.deepEqual(createModelCallLogger({ directory }).recent(), entries);
});

function historyRow(date, index, overrides = {}) {
  return { time: `${date}T00:00:00.000Z`, call_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    client: 'dsh', purpose: 'community_reply', event: 'finished', phase: 'completed',
    model: 'fixture-model', provider: 'fixture-provider', max_tokens: 64000, timeout_ms: 180000,
    timeout_kind: 'total_deadline', deadline_remaining_ms: null, elapsed_ms: 1200, first_output_ms: 50,
    text_characters: 100, reasoning_characters: 200, input_tokens: 80, output_tokens: 30,
    finish_kind: 'stop', error_code: null, ...overrides };
}

test('history loading rebuilds fixed fields, drops invalid identity rows and sanitizes old contents again', t => {
  const directory = isolatedDirectory(t);
  const date = '2026-10-28';
  const dirty = historyRow(date, 1, { model: PRIVATE_URL, provider: PRIVATE_URL, token: PRIVATE_KEY, raw: RAW_ERROR,
    text: PRIVATE_TEXT, reasoning: PRIVATE_TEXT, max_tokens: -1, timeout_ms: '180000', deadline_remaining_ms: 1.5,
    elapsed_ms: -1, first_output_ms: '50', text_characters: [], reasoning_characters: {}, input_tokens: 0.5,
    output_tokens: -1, timeout_kind: RAW_ERROR, finish_kind: RAW_ERROR, error_code: RAW_ERROR });
  const invalidRows = [
    { client: 'official-client' }, { purpose: RAW_ERROR }, { event: RAW_ERROR }, { phase: RAW_ERROR },
    { call_id: PRIVATE_KEY }, { time: '2026-10-28T00:00:00Z' }, { time: 'not-a-time' },
    { time: '2026-10-27T00:00:00.000Z' },
  ].map((overrides, index) => historyRow(date, index + 2, overrides));
  writeFileSync(join(directory, `${date}.jsonl`), [dirty, ...invalidRows, null, []].map(JSON.stringify).join('\n') + '\n{"truncated":', 'utf8');
  const recent = createModelCallLogger({ directory }).recent();
  assert.equal(recent.length, 1);
  assertSafe(recent);
  for (const field of ['model', 'provider', 'max_tokens', 'timeout_ms', 'deadline_remaining_ms', 'elapsed_ms',
    'first_output_ms', 'text_characters', 'reasoning_characters', 'input_tokens', 'output_tokens', 'timeout_kind', 'finish_kind']) {
    assert.equal(recent[0][field], null, field);
  }
  assert.equal(recent[0].error_code, 'UNKNOWN');
  assert.equal(recent[0].call_id, dirty.call_id);
});

test('history restores only the latest ten records from the two most recent dated files', t => {
  const directory = isolatedDirectory(t);
  const older = Array.from({ length: 8 }, (_, i) => historyRow('2026-10-26', i));
  const previous = Array.from({ length: 6 }, (_, i) => historyRow('2026-10-27', i + 10));
  const latest = Array.from({ length: 6 }, (_, i) => historyRow('2026-10-28', i + 20));
  for (const [date, rows] of [['2026-10-26', older], ['2026-10-27', previous], ['2026-10-28', latest]]) {
    writeFileSync(join(directory, `${date}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n', 'utf8');
  }
  writeFileSync(join(directory, 'latest.jsonl'), JSON.stringify(historyRow('2026-10-28', 99)), 'utf8');
  assert.deepEqual(createModelCallLogger({ directory }).recent(), [...previous, ...latest].slice(-10));
  // A malformed most-recent file does not cause older-than-two-days recovery.
  writeFileSync(join(directory, '2026-10-28.jsonl'), '{truncated\n', 'utf8');
  assert.deepEqual(createModelCallLogger({ directory }).recent(), previous);
});

test('history reads only the last 256 KiB of a dated file and skips the cut first line', t => {
  const directory = isolatedDirectory(t);
  const date = '2026-10-28';
  const beforeTail = historyRow(date, 1);
  const cutRow = historyRow(date, 2, { raw: PRIVATE_TEXT.repeat(15000) });
  const last = [historyRow(date, 3), historyRow(date, 4)];
  const content = [beforeTail, cutRow, ...last].map(JSON.stringify).join('\n') + '\n{"partial":';
  assert.ok(Buffer.byteLength(JSON.stringify(cutRow)) > 262144);
  writeFileSync(join(directory, `${date}.jsonl`), content, 'utf8');
  const recent = createModelCallLogger({ directory }).recent();
  assert.deepEqual(recent, last);
  assertSafe(recent);
});

test('first output starts only on nonblank text or reasoning, never usage or empty chunks', () => {
  for (const kind of ['text', 'reasoning']) {
    const f = recorder();
    const call = f.logger.start(metadata);
    call.dispatched();
    f.time = 12;
    call.observe({ type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } });
    call.observe({ type: 'block-start', index: 1, blockType: kind });
    call.observe(delta('', 1, kind));
    call.observe(delta(' \n\t', 1, kind));
    call.observe({ type: 'block-end', index: 0, block: { type: kind, text: '' } });
    assert.equal(f.entries.length, 2);
    f.time = 34;
    call.observe(delta('abc', 1, kind));
    assert.equal(f.entries.at(-1).event, 'first_output');
    assert.equal(f.entries.at(-1).first_output_ms, 34);
    assert.equal(f.entries.at(-1).phase, 'receiving');
    f.time = 56;
    call.observe(delta('def', 1, kind));
    assert.equal(f.entries.length, 3);
    call.finish();
    assert.equal(f.entries.at(-1).first_output_ms, 34);
    assert.equal(f.entries.at(-1)[`${kind}_characters`], 9);
  }
  const f = recorder();
  const call = f.logger.start(metadata);
  f.time = 7;
  call.observe({ type: 'block-end', index: 0, block: { type: 'text', text: 'complete block' } });
  assert.equal(f.entries.at(-1).first_output_ms, 7);
});

test('15-second timer summarizes cumulative progress without writing on every output chunk', () => {
  const f = recorder();
  const call = f.logger.start(metadata);
  call.dispatched();
  assert.deepEqual(f.intervals.map(timer => timer.ms), [15000]);
  for (let i = 0; i < 100; i++) call.observe(delta('abc'));
  assert.equal(f.entries.length, 3);
  f.time = 15000;
  f.intervals[0].callback();
  assert.equal(f.entries.length, 4);
  assert.equal(f.entries.at(-1).text_characters, 300);
  assert.equal(f.entries.at(-1).elapsed_ms, 15000);
  for (let i = 0; i < 50; i++) call.observe(delta('xy', 2, 'reasoning'));
  assert.equal(f.entries.length, 4);
  f.time = 30000;
  f.intervals[0].callback();
  assert.equal(f.entries.at(-1).reasoning_characters, 100);
  assert.equal(f.entries.at(-1).event, 'progress');
  call.finish();
  assert.deepEqual(f.cleared, [1]);
  const count = f.entries.length;
  f.intervals[0].callback();
  assert.equal(f.entries.length, count);
});

test('block-end replaces delta counts and duplicate/late block chunks do not count twice', () => {
  const f = recorder();
  const call = f.logger.start(metadata);
  for (const [index, kind] of [[0, 'reasoning'], [1, 'text']]) {
    call.observe(delta('ab', index, kind));
    call.observe(delta('cd', index, kind));
    call.observe({ type: 'block-end', index, block: { type: kind, text: 'abcd' } });
    call.observe({ type: 'block-end', index, block: { type: kind, text: 'abcd' } });
    call.observe(delta('late', index, kind));
  }
  call.finish();
  assert.equal(f.entries.at(-1).text_characters, 4);
  assert.equal(f.entries.at(-1).reasoning_characters, 4);
});

test('completion, failure, cancellation and timeout finish exactly once and ignore later chunks', () => {
  for (const [options, phase, code] of [[{}, 'completed', null], [{ code: 'AUTH' }, 'failed', 'AUTH'],
    [{ cancelled: true, code: 'run_stopped' }, 'cancelled', 'run_stopped'],
    [{ timedOut: true, code: 'game_deadline_expired' }, 'timed_out', 'game_deadline_expired']]) {
    const f = recorder();
    const call = f.logger.start(metadata);
    call.finish(options);
    call.finish({ code: 'UNKNOWN' });
    call.dispatched();
    call.observe(delta(PRIVATE_TEXT));
    f.intervals[0].callback();
    assert.equal(f.entries.filter(entry => entry.event === 'finished').length, 1);
    assert.equal(f.entries.length, 2);
    assert.equal(f.entries.at(-1).phase, phase);
    assert.equal(f.entries.at(-1).error_code, code);
    assert.deepEqual(f.cleared, [1]);
  }
});

test('specific provider failure survives generic adapter failures and only whitelisted source codes are retained', () => {
  for (const code of ['normalization_incomplete', 'normalization_model_failed', 'game_model_failed', 'invalid_model_decision', 'runtime_model_provider_error']) {
    const f = recorder();
    const call = f.logger.start(metadata);
    call.observe(finish('error', 'TIMEOUT'));
    call.finish({ code });
    assert.equal(f.entries.at(-1).error_code, 'TIMEOUT');
    assert.equal(f.entries.at(-1).phase, 'timed_out');
    assert.equal(f.entries.at(-1).finish_kind, 'error');
  }
  for (const [sourceCode, expected] of [['TRANSPORT', 'TRANSPORT'], ['AUTH', 'AUTH'], [RAW_ERROR, 'normalization_model_failed']]) {
    const f = recorder();
    const call = f.logger.start(metadata);
    call.finish({ sourceCode, code: 'normalization_model_failed' });
    assert.equal(f.entries.at(-1).error_code, expected);
    assertSafe(f.entries);
  }
});

test('recent returns only the latest ten records and caller mutation cannot change stored entries', () => {
  const f = recorder();
  for (let i = 0; i < 8; i++) f.logger.start({ ...metadata, model: `model-${i}` }).finish();
  const recent = f.logger.recent();
  assert.equal(recent.length, 10);
  assert.deepEqual(recent, f.entries.slice(-10));
  recent[0].model = 'changed';
  recent.pop();
  assert.deepEqual(f.logger.recent(), f.entries.slice(-10));
});

test('directory, append, timer and custom logger failures never escape logging calls', () => {
  for (const failingPart of ['makeDirectory', 'append', 'setTimer', 'clearTimer']) {
    const f = recorder({ [failingPart]() { throw new Error(RAW_ERROR); } });
    const call = beginModelCall(f.logger, metadata);
    assert.doesNotThrow(() => { call.dispatched(); call.observe(delta(PRIVATE_TEXT)); call.finish(); });
    assert.equal(f.logger.recent().at(-1).phase, 'completed');
    assertSafe(f.logger.recent());
  }
  for (const logger of [null, { start() { throw new Error(RAW_ERROR); } },
    { start() { return { dispatched() { throw new Error(RAW_ERROR); }, observe() { throw new Error(RAW_ERROR); }, finish() { throw new Error(RAW_ERROR); } }; } }]) {
    assert.doesNotThrow(() => { const call = beginModelCall(logger, metadata); call.dispatched(); call.observe({}); call.finish(); });
  }
});

const personaDescription = '我的名字是岛风。';
const personaResult = { name: { value: '岛风', evidence: '名字是岛风' }, overrides: Object.fromEntries(PERSONA_FIELDS.map(key => [key, null])) };
const adapterCases = [
  { name: 'community', purpose: 'community_reply', result: { participate: true, body: '公开回应' },
    create: (ctx, opts) => { const run = createRuntimeModel(() => ctx, opts); return signal => run({ post: PRIVATE_TEXT }, signal); },
    failureCode: 'runtime_model_transport', loggedFailure: 'runtime_model_transport', cancelCode: 'run_stopped' },
  { name: 'normalizer', purpose: 'persona_normalization', result: personaResult,
    create: (ctx, opts) => { const run = createDshNormalizer(ctx, opts); return signal => run({ description: personaDescription }, signal); },
    failureCode: 'normalization_model_failed', loggedFailure: 'TRANSPORT', cancelCode: 'normalization_timeout' },
  { name: 'game', purpose: 'game_decision', result: { action_id: 'pass', commentary: '等待' },
    create: (ctx, opts) => { const run = createDshGameDecider(ctx, { ...opts, monotonic: () => 0 });
      return signal => run({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { signal, deadline: 5000 }); },
    failureCode: 'game_model_failed', loggedFailure: 'TRANSPORT', cancelCode: 'game_decision_cancelled' },
];

function fakeContext(result, { failure, cancel } = {}) {
  const f = { prepares: 0, streams: 0, configs: [] };
  f.ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(config) {
      f.prepares++; f.configs.push(config);
      if (cancel) cancel();
      if (failure) throw Object.assign(new Error(RAW_ERROR), { code: 'TRANSPORT', token: PRIVATE_KEY });
      return { config, async *stream() {
        f.streams++;
        yield delta(PRIVATE_TEXT, 0, 'reasoning');
        yield delta(JSON.stringify(result));
        yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 30 } };
        yield finish();
      } };
    } } };
  return f;
}

test('all three adapters log successful calls at 64k without replacing runtime diagnostics', async t => {
  for (const spec of adapterCases) await t.test(spec.name, async () => {
    const f = recorder();
    const model = fakeContext(spec.result);
    const diagnostics = [];
    const result = await spec.create(model.ctx, { callLogger: f.logger, onDiagnostic: entry => diagnostics.push(entry) })();
    if (spec.name === 'normalizer') assert.equal(result.name, '岛风');
    else assert.deepEqual(result, spec.result);
    assert.equal(model.prepares, 1); assert.equal(model.streams, 1);
    assert.equal(model.configs[0].maxTokens, 64000);
    assert.equal(model.configs[0].reasoningEffort, 'max');
    const last = f.entries.at(-1);
    assert.equal(last.phase, 'completed'); assert.equal(last.purpose, spec.purpose);
    assert.equal(last.finish_kind, 'stop'); assert.equal(last.max_tokens, 64000);
    assert.equal(last.text_characters, JSON.stringify(spec.result).length);
    assert.equal(last.reasoning_characters, PRIVATE_TEXT.length);
    assert.equal(last.input_tokens, 80); assert.equal(last.output_tokens, 30);
    assert.equal(last.timeout_ms, spec.name === 'game' ? 4600 : 180000);
    assert.equal(last.timeout_kind, 'total_deadline');
    assert.equal(last.deadline_remaining_ms, spec.name === 'game' ? 5000 : null);
    assert.equal(f.entries.filter(entry => entry.event === 'finished').length, 1);
    if (spec.name === 'community') { assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].finishKind, 'stop'); }
    assertSafe(f.entries);
  });
});

test('all three adapters classify thrown failures and cancellation once without leaking raw errors or retrying', async t => {
  for (const spec of adapterCases) for (const cancelled of [false, true]) await t.test(`${spec.name} ${cancelled ? 'cancelled' : 'failed'}`, async () => {
    const f = recorder();
    const controller = new AbortController();
    const model = fakeContext(spec.result, cancelled ? { cancel: () => controller.abort(RAW_ERROR) } : { failure: true });
    await assert.rejects(() => spec.create(model.ctx, { callLogger: f.logger })(controller.signal), error => {
      assert.equal(error.code, cancelled ? spec.cancelCode : spec.failureCode);
      assert.ok(!error.message.includes(RAW_ERROR));
      if (spec.name === 'community') assert.ok(error.diagnostic);
      return true;
    });
    assert.equal(model.prepares, 1); assert.equal(model.streams, 0);
    assert.equal(f.entries.filter(entry => entry.event === 'finished').length, 1);
    const last = f.entries.at(-1);
    assert.equal(last.phase, cancelled ? 'cancelled' : 'failed');
    assert.equal(last.error_code, cancelled ? spec.cancelCode : spec.loggedFailure);
    assertSafe(f.entries);
  });
});

test('all three adapter results survive filesystem and custom logger failures', async t => {
  for (const spec of adapterCases) await t.test(spec.name, async () => {
    for (const callLogger of [recorder({ append() { throw new Error(RAW_ERROR); } }).logger,
      { start() { throw new Error(RAW_ERROR); } },
      { start() { return { dispatched() { throw new Error(RAW_ERROR); }, observe() { throw new Error(RAW_ERROR); }, finish() { throw new Error(RAW_ERROR); } }; } }]) {
      const model = fakeContext(spec.result);
      const result = await spec.create(model.ctx, { callLogger })();
      assert.equal(spec.name === 'normalizer' ? result.name : JSON.stringify(result), spec.name === 'normalizer' ? '岛风' : JSON.stringify(spec.result));
      assert.equal(model.prepares, 1); assert.equal(model.streams, 1);
    }
  });
});

test('game deadline expiry is logged separately from user cancellation', async () => {
  const f = recorder();
  const model = fakeContext({ action_id: 'pass', commentary: '' });
  model.ctx.llm.prepareCall = async () => { model.prepares++; await new Promise(resolve => setTimeout(resolve, 25)); return { config: {}, async *stream() { model.streams++; } }; };
  const run = createDshGameDecider(model.ctx, { callLogger: f.logger, monotonic: () => 0 });
  await assert.rejects(() => run({ action_request: { legal_actions: [{ action_id: 'pass' }] } }, { deadline: 405 }));
  assert.equal(f.entries.at(-1).phase, 'timed_out');
  assert.equal(f.entries.at(-1).error_code, 'game_deadline_expired');
  assert.equal(f.entries.at(-1).deadline_remaining_ms, 405);
  assert.equal(f.entries.at(-1).timeout_ms, 5);
  assert.equal(model.prepares, 1); assert.equal(model.streams, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.entries.filter(entry => entry.event === 'finished').length, 1);
  assert.equal(model.streams, 0);
});
