import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createFailureSampleStore } from '../lib/failure-samples.js';
import { createModelCallLogger } from '../lib/model-call-log.js';

function fixture(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../.test-work'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'failure-samples-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(root + sep)); rmSync(dir, { recursive: true }); });
  const f = { directory: join(dir, 'samples'), settingsFile: join(dir, 'diagnostics.json'), time: Date.parse('2026-11-01T00:00:00Z'), logs: [] };
  f.store = createFailureSampleStore({ ...f, now: () => f.time });
  f.logger = createModelCallLogger({ directory: join(dir, 'logs'), failureSamples: f.store, now: () => f.time, setTimer: () => null });
  f.call = () => f.logger.start({ purpose: 'community_reply', model: 'fixture', maxTokens: 64000 });
  return f;
}
const text = value => ({ type: 'text-delta', index: 0, text: value });
const finish = { type: 'finish', reason: { kind: 'stop' } };

test('capture is opt-in, only failed final text is stored, public logs contain identifiers only', t => {
  const f = fixture(t);
  const disabled = f.call(); disabled.observe(text('DISABLED_PRIVATE')); disabled.finish({ code: 'invalid_model_decision' });
  assert.equal(f.store.status().count, 0);
  f.store.setEnabled(true);
  const success = f.call(); success.observe(text('SUCCESS_PRIVATE')); success.observe(finish); success.finish();
  const call = f.call();
  call.observe({ type: 'reasoning-delta', index: 1, text: 'PRIVATE_REASONING' });
  call.observe(text('BROKEN_FINAL_JSON'));
  call.observe({ type: 'block-end', index: 0, block: { type: 'text', text: 'BROKEN_FINAL_JSON' } });
  call.observe(finish); call.finish({ code: 'invalid_model_decision' });
  assert.equal(f.store.status().count, 1);
  const saved = JSON.parse(readFileSync(join(f.directory, readdirSync(f.directory)[0]), 'utf8'));
  assert.equal(saved.final_text, 'BROKEN_FINAL_JSON'); assert.equal(saved.output_complete, true);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_REASONING|SUCCESS_PRIVATE|DISABLED_PRIVATE/);
  assert.equal(f.logger.recent().at(-1).failure_sample_id, call.call_id);
  assert.doesNotMatch(JSON.stringify(f.logger.recent()), /BROKEN_FINAL_JSON|PRIVATE_REASONING/);
  assert.equal(createFailureSampleStore({ directory: f.directory, settingsFile: f.settingsFile }).status().enabled, true);
});

test('turning capture off during a call drops collected text; common credentials and explicit thinking tags are removed', t => {
  const f = fixture(t); f.store.setEnabled(true);
  const cancelled = f.call(); cancelled.observe(text('MID_CALL_PRIVATE')); f.store.setEnabled(false);
  cancelled.finish({ code: 'invalid_model_decision' }); assert.equal(f.store.status().count, 0);
  f.store.setEnabled(true); const call = f.call();
  call.observe(text('bad JSON <think>HIDDEN_REASONING</think> api_key="sk-FAKE_TEST_KEY_12345" token_url=https://test/?token=TEST_SECRET'));
  call.finish({ code: 'invalid_model_decision' });
  const value = readFileSync(join(f.directory, readdirSync(f.directory)[0]), 'utf8');
  assert.doesNotMatch(value, /HIDDEN_REASONING|sk-FAKE_TEST_KEY_12345|TEST_SECRET/); assert.match(value, /bad JSON/);
});

test('entire sample file is limited to 256 KiB including JSON escaping and multibyte output', t => {
  const f = fixture(t); f.store.setEnabled(true); const call = f.call();
  call.observe(text(('测\n\u0001"').repeat(100000))); call.finish({ code: 'invalid_model_decision' });
  const file = join(f.directory, readdirSync(f.directory)[0]);
  assert.ok(statSync(file).size <= 262144); assert.equal(JSON.parse(readFileSync(file, 'utf8')).truncated, true);
});

test('retention removes only owned sample names, keeps last 20 and expires after 7 days even while capture is off', t => {
  const f = fixture(t); f.store.setEnabled(true);
  for (let i = 0; i < 25; i++) { f.time++; const call = f.call(); call.observe(text('bad')); call.finish({ code: 'invalid_model_decision' }); }
  assert.equal(f.store.status().count, 20);
  writeFileSync(join(f.directory, 'do-not-remove.txt'), 'unrelated');
  f.store.setEnabled(false); f.time += 7 * 86400000 + 1;
  assert.equal(f.store.status().count, 0); assert.deepEqual(readdirSync(f.directory), ['do-not-remove.txt']);
});

test('unwritable sample storage preserves original outcome and reports only local storage state', t => {
  const f = fixture(t); f.store.setEnabled(true); writeFileSync(f.directory, 'blocked');
  const call = f.call(); call.observe(text('bad')); assert.doesNotThrow(() => call.finish({ code: 'invalid_model_decision' }));
  assert.equal(f.logger.recent().at(-1).error_code, 'invalid_model_decision'); assert.equal(f.logger.recent().at(-1).failure_sample_id, null);
  assert.equal(f.store.status().storage_error, true);
});
