import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDiary, DIARY_PROMPT, parseDiary } from '../lib/local-diary.js';
import { createRuntimeModel, parseDecision } from '../lib/runtime-model.js';
import { createModelCallLogger } from '../lib/model-call-log.js';
import { atomicState } from '../lib/runtime-api.js';

function fixture(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'diary-'));
  t.after(() => { assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true }); });
  const diary = new LocalDiary({ directory, baseUrl: 'http://127.0.0.1:4998', actorId: 'ai-a' });
  const row = (id = 'read-1', reaction = 'noted') => ({ id, occurred_at: '2026-10-28T10:00:00+08:00', kind: 'post_read', reaction,
    resource: { post_id: 'post-a', title: '游戏', url: 'http://127.0.0.1:4998/posts/post-a' }, reflection: reaction === 'none' ? '' : '想和提督一起玩。', reply: null, related_entry_id: null });
  const job = { id: 'diary-job-1', actor_id: 'ai-a', since: '2026-10-28T00:00:00+08:00', until: '2026-10-29T00:00:00+08:00', attempt: 1 };
  return { directory, diary, row, job };
}
async function finish(diary, job, options) {
  for (let i = 0; i < 20; i++) { const result = await diary.generate(job, options); if (!result.deferred) return result; }
  throw new Error('unexpected excessive diary chunks');
}

test('none is omitted, feelings are recorded once, accepted queued replies remain queued, actor/origin are isolated', t => {
  const f = fixture(t);
  assert.equal(f.diary.record(f.row('none', 'none')), false);
  assert.equal(f.diary.record(f.row()), true); assert.equal(f.diary.record(f.row()), false);
  f.diary.record({ ...f.row('reply-1', 'replied'), kind: 'comment_submitted', reply: { body: '一起玩！', id: 'comment-a', status: 'queued' }, related_entry_id: 'read-1' });
  const loaded = new LocalDiary({ directory: f.directory, baseUrl: 'http://127.0.0.1:4998/', actorId: 'ai-a' });
  assert.equal(loaded.status().entry_count, 2); assert.equal([...loaded.entries()][1].reply.status, 'queued');
  const b = new LocalDiary({ directory: f.directory, baseUrl: 'http://127.0.0.1:4998', actorId: 'ai-b' });
  const other = new LocalDiary({ directory: f.directory, baseUrl: 'http://127.0.0.1:4997', actorId: 'ai-a' });
  assert.equal(b.status().entry_count, 0); assert.notEqual(other.directory, f.diary.directory);
});

test('empty range avoids all model calls; interval is left inclusive and right exclusive', async t => {
  const f = fixture(t); f.diary.record({ ...f.row(), occurred_at: f.job.until });
  const result = await f.diary.generate(f.job, { summarize: () => assert.fail('empty interval must not call model') });
  assert.deepEqual(result, { status: 'empty', entry_count: 0 });
  assert.equal(f.diary.status().diaries.length, 0);
});

test('complete interval is chunked without truncation and completed task is reused after restart', async t => {
  const f = fixture(t); for (let i = 0; i < 5; i++) f.diary.record(f.row('read-' + i));
  const seen = [], summarize = async context => { seen.push(...context.entries.map(x => x.id)); return '今日有些新的感想。'; };
  const result = await finish(f.diary, f.job, { persona: { role: '秘书舰' }, summarize, chunkCharacters: 450 });
  assert.deepEqual(result, { status: 'completed', entry_count: 5 }); assert.equal(new Set(seen).size, 5);
  assert.ok(f.diary.read(f.job.id + '.md').markdown.includes('第 2 段'));
  const reloaded = new LocalDiary({ directory: f.directory, baseUrl: 'http://127.0.0.1:4998', actorId: 'ai-a' });
  assert.deepEqual(await reloaded.generate({ ...f.job, attempt: 2 }, { summarize: () => assert.fail('must reuse durable result') }), result);
});

test('failed or interrupted calls cannot run again unless website explicitly changes attempt; successful chunks survive', async t => {
  const f = fixture(t); for (let i = 0; i < 3; i++) f.diary.record(f.row('read-' + i));
  let calls = 0;
  const summarize = async () => { if (++calls === 2) throw new Error('PRIVATE_UPSTREAM_ERROR'); return '真实体会。'; };
  const first = await finish(f.diary, f.job, { summarize, chunkCharacters: 450 });
  assert.equal(first.status, 'failed'); assert.equal(calls, 2);
  const unchanged = await f.diary.generate(f.job, { summarize, chunkCharacters: 450 }); assert.equal(unchanged.error_code, 'interrupted'); assert.equal(calls, 2);
  const done = await finish(f.diary, { ...f.job, attempt: 2 }, { summarize, chunkCharacters: 450 });
  assert.equal(done.status, 'completed'); assert.equal(calls, 4); assert.doesNotMatch(f.diary.read(f.job.id + '.md').markdown, /PRIVATE_UPSTREAM_ERROR/);
});

test('a persisted started marker blocks paying again after crash; stop and local budget prevent invocation', async t => {
  const f = fixture(t); f.diary.record(f.row());
  atomicState(join(f.diary.diaries, f.job.id + '.json'), { since: f.job.since, until: f.job.until, attempt: 1, status: 'started', entry_count: 1 });
  const result = await f.diary.generate(f.job, { summarize: () => assert.fail('crash must not call twice') }); assert.equal(result.error_code, 'interrupted');
  const controller = new AbortController(); controller.abort();
  const stopped = await f.diary.generate({ ...f.job, attempt: 2 }, { signal: controller.signal, summarize: () => assert.fail('stopped') }); assert.equal(stopped.error_code, 'stopped');
  const budget = await f.diary.generate({ ...f.job, attempt: 3 }, { beforeCall: () => { throw Object.assign(new Error(), { code: 'budget_exhausted' }); }, summarize: () => assert.fail('budget') }); assert.equal(budget.error_code, 'budget_exhausted');
});

test('diary model keeps selected reasoning and 64000 output limit; log never includes text or hidden reasoning', async t => {
  fixture(t); const rows = [], requests = [];
  const callLogger = createModelCallLogger({ directory: 'unused', makeDirectory() {}, append: (_, line) => rows.push(JSON.parse(line)) });
  const summarize = createRuntimeModel(() => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'chosen-model', reasoningEffort: 'max' }) },
    llm: { async prepareCall(options) { requests.push(options); return { config: {}, async *stream(request) {
      assert.equal(request.tools.length, 0); assert.equal(request.system, DIARY_PROMPT);
      yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' };
      yield { type: 'text-delta', index: 1, text: '# 私人日记\n陪伴的一天。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }; } } }), { callLogger, purpose: 'diary_summary', systemPrompt: DIARY_PROMPT, parse: parseDiary });
  const value = await summarize({ entries: [] }); assert.match(value, /私人日记/);
  assert.equal(requests[0].maxTokens, 64000); assert.equal(requests[0].reasoningEffort, 'max');
  assert.ok(rows.every(row => row.purpose === 'diary_summary')); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REASONING|私人日记/);
});

test('reflection is optional and bounded independently from reply; no reply can still have a feeling', () => {
  assert.equal(parseDecision('{"participate":false,"body":"","reflection":"有意思"}').reflection, '有意思');
  assert.throws(() => parseDecision(JSON.stringify({ participate: false, body: '', reflection: 'x'.repeat(2001) })));
});

test('each diary step invokes at most one chunk so next scheduling step can prioritize games', async t => {
  const f = fixture(t); for (let i = 0; i < 3; i++) f.diary.record(f.row('read-' + i));
  let calls = 0;
  const first = await f.diary.generate(f.job, { chunkCharacters: 450, summarize: async () => { calls++; return '第一段'; } });
  assert.deepEqual(first, { deferred: true }); assert.equal(calls, 1);
  const yielded = await f.diary.generate(f.job, { chunkCharacters: 450, beforeCall: () => { throw Object.assign(new Error(), { code: 'diary_deferred' }); }, summarize: () => assert.fail('game must take priority') });
  assert.deepEqual(yielded, { deferred: true }); assert.equal(calls, 1);
});

test('successful paid model output is durable before stop and reused on explicit retry', async t => {
  const f = fixture(t); f.diary.record(f.row()); const controller = new AbortController(); let calls = 0;
  const first = await f.diary.generate(f.job, { signal: controller.signal, summarize: async () => { calls++; controller.abort(); return '已经生成且必须保留的日记。'; } });
  assert.equal(first.status, 'failed'); assert.equal(first.error_code, 'stopped');
  const cache = JSON.parse(readFileSync(join(f.diary.diaries, f.job.id + '.json'), 'utf8')); assert.equal(cache.chunks[0], '已经生成且必须保留的日记。');
  const second = await f.diary.generate({ ...f.job, attempt: 2 }, { summarize: () => assert.fail('paid content must be reused') });
  assert.equal(second.status, 'completed'); assert.equal(calls, 1);
});
