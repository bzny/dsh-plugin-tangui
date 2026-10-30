import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';
import { LocalDiary } from '../lib/local-diary.js';
import { registerThoughtsTool } from '../lib/thoughts-tool.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
function fixture(t, timezone = 'Asia/Shanghai') {
  const directory = join(ROOT, `thoughts-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  let binding = { actorId: 'thoughts-ai', baseUrl: 'https://community.example', token: 'FIXTURE_LOCAL_ONLY', scopes: [] };
  const connection = { binding: () => binding };
  const runtime = new CommunityRuntime({ directory, connection, fetchImpl() { assert.fail('local thoughts must not use the network'); }, decide() { assert.fail('local thoughts must not call a model'); } });
  if (timezone) runtime.commit({ diary_timezone: timezone });
  const record = (id, time, reflection, kind = 'post_read', extra = {}) => runtime.diary.record({ id, occurred_at: time, reflection, kind, reaction: null,
    resource: { post_id: 'post-test', title: '隔离测试材料', url: 'PRIVATE_URL' }, ...extra });
  t.after(() => { const child = relative(ROOT, resolve(directory)); assert.ok(child && !child.startsWith('..') && !child.includes(':')); rmSync(directory, { recursive: true }); });
  return { directory, runtime, record, setBinding(next) { binding = next; }, binding: () => binding };
}

test('thoughts use diary timezone across UTC file boundaries, newest first then chronological selected day', t => {
  const f = fixture(t);
  f.record('a', '2026-10-29T15:59:00Z', '昨日最后一条');
  f.record('b', '2026-10-29T16:00:00Z', '今日第一条', 'game_intention');
  f.record('c', '2026-10-30T02:00:00+08:00', '今日第二条', 'game_reflection');
  f.record('d', '2026-10-30T18:00:00Z', '明日一条');
  const newest = f.runtime.readThoughts();
  assert.deepEqual(newest.items.map(row => row.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(newest.dates, [{ date: '2026-10-31', count: 1 }, { date: '2026-10-30', count: 2 }, { date: '2026-10-29', count: 1 }]);
  const selected = f.runtime.readThoughts({ date: '2026-10-30' });
  assert.equal(selected.order, 'asc'); assert.deepEqual(selected.items.map(row => row.id), ['b', 'c']);
  assert.deepEqual(selected.items.map(row => row.local_time), ['00:00:00', '02:00:00']);
  assert.equal(selected.timezone, 'Asia/Shanghai'); assert.equal(selected.timezone_known, true);
});
test('only authored nonempty reflections are shown, duplicate reply copies and hidden/raw fields are excluded', t => {
  const f = fixture(t), time = '2026-10-30T01:00:00Z';
  f.record('read', time, '阅读后想认真试试。', 'post_read', { reasoning: 'PROVIDER_HIDDEN', summary: 'RAW_DIAGNOSTIC' });
  f.record('reply', time, '阅读后想认真试试。', 'comment_submitted', { related_entry_id: 'read', reply: { body: 'PUBLIC_REPLY_NOT_A_THOUGHT' } });
  f.record('reply-old', time, '只有旧回复记录保留的感想', 'comment_submitted');
  f.record('empty', time, '   ', 'post_read');
  f.record('runtime', time, 'PURE_LOG', 'game_finished');
  f.record('provider', time, 'PROVIDER_HIDDEN', 'model_call');
  const page = f.runtime.readThoughts();
  assert.equal(page.total, 2); assert.deepEqual(new Set(page.items.map(row => row.kind)), new Set(['post_read', 'comment_submitted']));
  assert.doesNotMatch(JSON.stringify(page), /PROVIDER_HIDDEN|RAW_DIAGNOSTIC|PRIVATE_URL|PUBLIC_REPLY_NOT_A_THOUGHT|PURE_LOG/);
});
test('cursor pagination is stable with newly added thoughts and rejects a changed date or timezone', t => {
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) f.record(`entry-${i}`, `2026-10-30T0${i}:00:00Z`, `想法${i}`);
  const first = f.runtime.readThoughts({ limit: 2 }); assert.equal(first.has_more, true);
  f.record('new', '2026-10-30T07:00:00Z', '后来新增');
  const second = f.runtime.readThoughts({ cursor: first.next_cursor, limit: 2 });
  const third = f.runtime.readThoughts({ cursor: second.next_cursor, limit: 2 });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(row => row.id), ['entry-5', 'entry-4', 'entry-3', 'entry-2', 'entry-1']);
  assert.equal(third.next_cursor, null); assert.equal(third.has_more, false);
  assert.throws(() => f.runtime.readThoughts({ cursor: first.next_cursor, date: '2026-10-30' }), { code: 'thoughts_query_changed' });
  f.runtime.commit({ diary_timezone: 'UTC' });
  assert.throws(() => f.runtime.readThoughts({ cursor: first.next_cursor }), { code: 'thoughts_query_changed' });
});
test('missing timezone allows explicit UTC newest-first view and only blocks day filtering', t => {
  const f = fixture(t, null); f.record('one', '2026-10-29T16:00:00Z', '尚无同步时区的感想');
  const page = f.runtime.readThoughts();
  assert.equal(page.timezone, null); assert.equal(page.timezone_known, false); assert.equal(page.display_timezone, 'UTC');
  assert.equal(page.items[0].local_date, '2026-10-29'); assert.deepEqual(page.dates, []); assert.match(page.notice, /UTC/);
  assert.throws(() => f.runtime.readThoughts({ date: '2026-10-30' }), { code: 'thoughts_timezone_unavailable' });
  assert.throws(() => f.runtime.readThoughts({ date: '2026-02-30' }), { code: 'invalid_thoughts_query' });
});
test('an already fetched diary timezone remains usable after restart without another network read', async t => {
  const f = fixture(t, null); f.record('one', '2026-10-29T16:05:00Z', '已同步时区的跨日感想');
  f.runtime.abort = new AbortController();
  f.runtime.api = { data: async () => ({ community: {}, diary: { timezone: 'Asia/Shanghai' } }) };
  await f.runtime.refreshPreferences();
  const restarted = new CommunityRuntime({ directory: f.directory, connection: { binding: f.binding }, fetchImpl() { assert.fail('must stay local'); } });
  const page = restarted.readThoughts({ date: '2026-10-30' });
  assert.equal(page.total, 1); assert.equal(page.items[0].local_time, '00:05:00'); assert.equal(page.timezone, 'Asia/Shanghai');
});
test('day ordering uses actual instants even when daylight-saving time repeats the displayed clock', t => {
  const f = fixture(t, 'America/New_York');
  f.record('before-fallback', '2026-11-01T05:30:00Z', '第一次一点半');
  f.record('after-fallback', '2026-11-01T06:30:00Z', '第二次一点半');
  const page = f.runtime.readThoughts({ date: '2026-11-01', limit: 1 });
  const next = f.runtime.readThoughts({ date: '2026-11-01', limit: 1, cursor: page.next_cursor });
  assert.equal(page.items[0].id, 'before-fallback'); assert.equal(next.items[0].id, 'after-fallback');
  assert.equal(page.items[0].local_time, next.items[0].local_time);
});
test('identity guards and cursors isolate a switched companion without writing new state or directories', t => {
  const f = fixture(t); f.record('old-1', '2026-10-30T01:00:00Z', 'OLD_IDENTITY_PRIVATE'); f.record('old-2', '2026-10-30T02:00:00Z', 'OLD_IDENTITY_PRIVATE');
  const previous = f.runtime.readThoughts({ limit: 1 });
  const oldState = readFileSync(f.runtime.stateFile, 'utf8'), oldFiles = readdirSync(join(f.directory, 'local-memory'));
  f.setBinding({ ...f.binding(), actorId: 'fresh-ai' });
  assert.throws(() => f.runtime.readThoughts({ expected_actor_id: 'thoughts-ai' }), { code: 'thoughts_identity_changed' });
  assert.throws(() => f.runtime.readThoughts({ cursor: previous.next_cursor }), { code: 'thoughts_identity_changed' });
  const fresh = f.runtime.readThoughts({ expected_actor_id: 'fresh-ai', expected_base_url: 'https://community.example/' });
  assert.equal(fresh.identity.actor_id, 'fresh-ai'); assert.deepEqual(fresh.items, []); assert.equal(fresh.total, 0);
  assert.equal(readFileSync(f.runtime.stateFile, 'utf8'), oldState); assert.deepEqual(readdirSync(join(f.directory, 'local-memory')), oldFiles);
  assert.doesNotMatch(JSON.stringify(fresh), /OLD_IDENTITY_PRIVATE/);
});
test('read-only thoughts tool works while the runtime is active without approvals, models, controller changes or writes', async t => {
  const f = fixture(t); f.record('one', '2026-10-30T01:00:00Z', '仅本地查看');
  let tool, entered;
  registerThoughtsTool({ tools: { register(value) { tool = value; } } }, { runtime: f.runtime,
    withOperation(work, readOnly) { entered = readOnly; return work(); } });
  const before = readFileSync(f.runtime.stateFile, 'utf8'); f.runtime.task = Promise.resolve();
  const result = await tool.execute({}, { signal: new AbortController().signal });
  assert.equal(tool.name, 'tangui_thoughts'); assert.equal(entered, true); assert.equal(result.thoughts.items[0].reflection, '仅本地查看');
  assert.equal(readFileSync(f.runtime.stateFile, 'utf8'), before); assert.equal(f.runtime.lease, null);
  const readonly = new LocalDiary({ directory: join(f.directory, 'missing'), baseUrl: 'https://community.example', actorId: 'new-ai', readOnly: true });
  assert.throws(() => readonly.record({}), { code: 'diary_read_only' });
});
