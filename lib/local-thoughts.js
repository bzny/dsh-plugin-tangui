import { fail } from './runtime-api.js';

const KINDS = Object.freeze({ post_read: '读帖有感', comment_submitted: '互动感想', game_intention: '游戏当时的短记', game_reflection: '赛后回想' });
const compare = (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateThoughtsInput(value = {}) {
  const fields = ['date', 'cursor', 'limit', 'expected_actor_id', 'expected_base_url'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k)) ||
      (value.date !== undefined && !validDate(value.date)) ||
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2000}$/.test(value.cursor))) ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) ||
      (value.expected_actor_id !== undefined && (typeof value.expected_actor_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.expected_actor_id))) ||
      (value.expected_base_url !== undefined && (typeof value.expected_base_url !== 'string' || value.expected_base_url.length > 2048))) throw fail('invalid_thoughts_query', '想法查询仅接受有效日期、分页和当前账号标识。');
  return value;
}

export function knownThoughtTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 80) return null;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(0); return value; } catch { return null; }
}

/** One view over original diary entries. No second store, network or model. */
export function readThoughtEntries(entries, { identity, timezone, ...query }) {
  validateThoughtsInput(query);
  timezone = knownThoughtTimezone(timezone);
  const date = query.date || null, order = date ? 'asc' : 'desc', displayTimezone = timezone || 'UTC';
  if (date && !timezone) throw fail('thoughts_timezone_unavailable', '伙伴日记时区尚未同步，暂不能按伙伴日期筛选；仍可倒序阅读全部想法。');
  let cursor = null;
  if (query.cursor) {
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw fail('invalid_thoughts_cursor', '想法分页位置无效，请从第一页重新读取。'); }
    if (cursor?.version !== 1 || !Number.isFinite(cursor.time) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 500) throw fail('invalid_thoughts_cursor', '想法分页位置无效，请从第一页重新读取。');
    if (cursor.actor_id !== identity.actor_id || cursor.base_url !== identity.base_url) throw fail('thoughts_identity_changed', '伙伴身份已变化，请重新打开当前伙伴的想法。');
    if (cursor.date !== date || cursor.timezone !== timezone) throw fail('thoughts_query_changed', '日期或伙伴时区已变化，请从第一页重新读取。');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: displayTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const byId = new Map();
  for (const row of entries) {
    if (!Object.hasOwn(KINDS, row.kind) || typeof row.reflection !== 'string' || !row.reflection.trim() || byId.has(row.id)) continue;
    byId.set(row.id, row);
  }
  const rows = [], dates = new Map();
  for (const row of byId.values()) {
    // A submitted reply can carry a copy of the already saved reading thought.
    // Show that original thought once; do not collapse independent equal text.
    if (row.kind === 'comment_submitted' && byId.get(row.related_entry_id)?.reflection.trim() === row.reflection.trim()) continue;
    const time = Date.parse(row.occurred_at), parts = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (timezone) dates.set(localDate, (dates.get(localDate) || 0) + 1);
    if (date && date !== localDate) continue;
    const resource = {};
    for (const key of ['post_id', 'room_id', 'game_id']) if (typeof row.resource?.[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.resource[key])) resource[key] = row.resource[key];
    if (typeof row.resource?.title === 'string') resource.title = row.resource.title.slice(0, 160);
    rows.push({ time, id: row.id, occurred_at: row.occurred_at, local_date: localDate,
      local_time: `${parts.hour}:${parts.minute}:${parts.second}`, kind: row.kind, kind_label: KINDS[row.kind], reflection: row.reflection.trim(), resource });
  }
  rows.sort(order === 'asc' ? compare : (a, b) => compare(b, a));
  const following = cursor ? rows.filter(row => order === 'asc' ? compare(row, cursor) > 0 : compare(row, cursor) < 0) : rows;
  const page = following.slice(0, query.limit || 20), more = following.length > page.length, last = page.at(-1);
  const next = more ? Buffer.from(JSON.stringify({ version: 1, ...identity, date, timezone, time: last.time, id: last.id })).toString('base64url') : null;
  return { identity: { ...identity }, timezone, display_timezone: displayTimezone, timezone_known: timezone !== null,
    order, date, items: page.map(({ time, ...row }) => row), dates: [...dates].sort((a, b) => b[0].localeCompare(a[0])).map(([day, count]) => ({ date: day, count })),
    next_cursor: next, has_more: more, total: rows.length,
    notice: timezone ? '仅展示这个伙伴保存在本机的成文感想，不是模型内部思考；日期按伙伴日记时区计算，不上传社区。'
      : '伙伴日记时区尚未同步，时间先按UTC显示；同步前暂不能按伙伴日期筛选。这里只展示本机成文感想，不是模型内部思考。' };
}
