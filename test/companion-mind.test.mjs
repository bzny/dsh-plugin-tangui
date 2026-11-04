import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CompanionMind, MIND_INSTRUCTION, parseMind, parseEmbeddedAppraisal } from '../lib/companion-mind.js';
import { serviceMind, mindResting } from '../lib/mind-runtime.js';

function fixture() {
  let time = Date.parse('2026-11-01T04:00:00Z');
  let identity = { base_url: 'http://localhost:4999', actor_id: 'a1', memory_dir: 'X:/test/companion-one' };
  const testRoot = resolve('.test-work'); mkdirSync(testRoot, { recursive: true });
  const options = { directory: mkdtempSync(join(testRoot, 'tangui-mind-test-')), identity: () => identity, now: () => time };
  const mind = new CompanionMind(options);
  const guard = () => ({ expected_actor_id: identity.actor_id, expected_base_url: identity.base_url });
  mind.configure({ ...guard(), settings: { enabled: true, quiet_start: '00:00', quiet_end: '00:00' } });
  return { mind, options, guard, tick: n => { time += n; }, change: x => { identity = x; }, now: () => time };
}
function appraise(f, id, extra = {}) {
  f.mind.noteEvent({ id, source: 'community', summary: '实际读到了值得思考的内容' });
  return f.mind.recordAppraisal({ event_ids: [id], summary: '愿意私下聊聊', reflection: '我想把这件事讲给熟悉的人听。', delta: { mood: 3 }, ...extra });
}
const initial = { traits: { sociability: 20, optimism: 35 }, baselines: { mood: 50, energy: 55, pressure: 35 },
  activities: { public: 20, private: 85, reflect: 90 }, description: '安静但喜欢与熟悉的人详细交流，愿意思考风险。' };

test('management research seeds persist only abstract questions and follow identity, correction and exclusion', () => {
  const f = fixture();
  const event = f.mind.noteDialog({ session_id: 'management', event_id: 'message-1', role: 'user', text: 'PRIVATE_TRANSCRIPT_SENTINEL 今天这局麻将有点可惜。' });
  const inspiration = { question: '连续失利会如何影响风险偏好？', keywords: ['游戏', '风险判断'] };
  const value = { event_ids: [event.id], summary: 'PRIVATE_SUMMARY_SENTINEL', reflection: 'PRIVATE_REFLECTION_SENTINEL', inspiration };
  const options = { session_id: 'management', management_session_id: 'management' };
  f.mind.recordAppraisal(value, options);
  assert.equal(f.mind.recordAppraisal(value, options).duplicate, true);
  const reopened = new CompanionMind(f.options), seeds = reopened.researchSeeds('management');
  assert.deepEqual(seeds, [{ id: event.id, ...inspiration, at: new Date(f.now()).toISOString() }]);
  assert.doesNotMatch(JSON.stringify(seeds), /PRIVATE_|reflection|summary|source|memory_dir/);
  assert.equal(reopened.researchSeeds('another-session').length, 0);
  assert.equal(reopened.researchSeeds(undefined).length, 0);
  reopened.session({ ...f.guard(), session_id: 'management', included: false });
  assert.equal(reopened.researchSeeds('management').length, 0);
  reopened.session({ ...f.guard(), session_id: 'management', included: true });
  reopened.correct({ ...f.guard(), event_id: event.id, explanation: '这段是在讨论虚构情节，不是实际活动。' });
  assert.equal(reopened.researchSeeds('management').length, 0);
  f.change({ base_url: 'http://localhost:4999', actor_id: 'a2', memory_dir: 'X:/test/companion-two' });
  assert.equal(reopened.researchSeeds('management').length, 0);
});

test('community models cannot create local inspirations and seeds require an actual human dialogue event', () => {
  const f = fixture(), inspiration = { question: '协作游戏怎样影响风险选择？', keywords: ['协作游戏'] };
  const human = f.mind.noteDialog({ session_id: 'management', event_id: 'h1', role: 'user', text: '今天一起玩了一个合作游戏。' });
  const value = { event_ids: [human.id], summary: '', reflection: '', inspiration };
  assert.throws(() => parseMind(JSON.stringify(value)), { code: 'life_invalid_appraisal' });
  assert.throws(() => parseEmbeddedAppraisal({ summary: '', reflection: '', inspiration }), { code: 'life_invalid_appraisal' });
  assert.throws(() => f.mind.recordAppraisal(value), { code: 'life_invalid_appraisal' });
  assert.throws(() => f.mind.recordAppraisal(value, { session_id: 'management', management_session_id: 'different' }), { code: 'life_invalid_appraisal' });
  const assistant = f.mind.noteDialog({ session_id: 'management', event_id: 'a1', role: 'assistant', text: '计划下次继续尝试。' });
  assert.throws(() => f.mind.recordAppraisal({ ...value, event_ids: [assistant.id] }, { session_id: 'management', management_session_id: 'management' }), { code: 'life_event_mismatch' });
  f.mind.noteEvent({ id: 'public-event', source: 'community', summary: '公开帖子内容', session_id: 'management' });
  assert.throws(() => f.mind.recordAppraisal({ ...value, event_ids: [human.id, 'public-event'] }, { session_id: 'management', management_session_id: 'management' }), { code: 'life_event_mismatch' });
  assert.equal(f.mind.pending('management').length, 3, 'rejected seeds must not consume the original experiences');
});

test('inspiration filters reject obvious private material and copied dialogue; selection is bounded and does not resurrect disabled history', () => {
  const f = fixture(), opts = { session_id: 'management', management_session_id: 'management' };
  const event = f.mind.noteDialog({ session_id: 'management', event_id: 'private', role: 'user', text: '昨天讨论的私人项目名称属于特别敏感的公司工作资料，需要留在本地。' });
  const value = { event_ids: [event.id], summary: '', reflection: '' };
  for (const question of ['联系 somebody@example.com 询问活动？', 'api_key=sk_12345678901234567890', '如何使用 C:\\private\\work 文件？', '我们的提督今天为何特别疲惫？', '昨天讨论的私人项目名称属于特别敏感的公司工作资料，有什么影响？']) {
    assert.throws(() => f.mind.recordAppraisal({ ...value, inspiration: { question, keywords: [] } }, opts), { code: 'life_inspiration_invalid' });
  }
  for (let i = 0; i < 15; i++) {
    const e = f.mind.noteDialog({ session_id: 'management', event_id: 'new-' + i, role: 'user', text: '又讨论了一个实际活动。' });
    f.mind.recordAppraisal({ event_ids: [e.id], summary: '', reflection: '', inspiration: { question: `协作机制的第 ${i} 个问题如何研究？`, keywords: ['协作'] } }, opts);
    f.tick(1000);
  }
  assert.equal(f.mind.researchSeeds('management').length, 12);
  assert.match(f.mind.researchSeeds('management')[0].question, /14/);
  f.mind.configure({ ...f.guard(), settings: { enabled: false } });
  assert.equal(f.mind.researchSeeds('management').length, 0);
  f.tick(1000); f.mind.configure({ ...f.guard(), settings: { enabled: true } });
  assert.equal(f.mind.researchSeeds('management').length, 0);
});

test('same persona sessions share state; excluded sessions, unknown evidence and old history cannot affect it', () => {
  const f = fixture(); f.mind.registerSession({ id: 'one' }); f.mind.registerSession({ id: 'two' });
  const row = f.mind.noteDialog({ session_id: 'one', event_id: 'msg1', role: 'user', text: '今天一起完成了小目标' });
  f.mind.recordAppraisal({ event_ids: [row.id], summary: '有点开心', reflection: '一起做完了', delta: { mood: 8 } }, { session_id: 'one' });
  assert.equal(f.mind.context('two').current.values.mood, 58);
  assert.equal(f.mind.context('two').events.length, 0);
  f.mind.session({ ...f.guard(), session_id: 'two', included: false });
  assert.equal(f.mind.noteDialog({ session_id: 'two', event_id: 'm2', role: 'user', text: '这是另一个临时角色' }), null);
  assert.equal(f.mind.noteEvent({ id: 'old', source: 'dialogue', summary: '历史消息', at: '2020-01-01T00:00:00Z' }), null);
  assert.throws(() => f.mind.recordAppraisal({ event_ids: ['invented'], summary: 'x', reflection: 'x' }), /实际收到/);
});

test('introversion retains strong private/reflection interest, no overall quality or activity score', () => {
  const f = fixture(); appraise(f, 'e1', { profile: initial, activities: { public: 10, private: 90, reflect: 95 } });
  const view = f.mind.status();
  assert.equal(view.personality.traits.sociability, 20);
  assert.equal(view.current.activities.private, 90);
  assert.equal(view.current.activities.reflect, 95);
  assert.equal(view.quality, undefined);
  assert.match(MIND_INSTRUCTION, /内向\/悲观不等于低活跃/);
  assert.equal(f.mind.recordAppraisal({ event_ids: ['e1'], summary: '重复', reflection: '', delta: { mood: 10 } }).duplicate, true);
  assert.equal(f.mind.status().current.values.mood, view.current.values.mood);
});

test('growth accumulates across days; A does not take effect before exact revision approval', () => {
  const f = fixture(), growth = { trait: 'sociability', direction: -1, reason: '多次更愿意与熟人深入交流' };
  appraise(f, 'd1a', { profile: initial, growth }); appraise(f, 'd1b', { growth }); appraise(f, 'd1c', { growth });
  assert.equal(f.mind.status().growth.pending, null);
  f.tick(86400000); appraise(f, 'd2', { growth });
  const before = f.mind.status(), pending = before.growth.pending;
  assert.ok(pending); assert.equal(before.personality.traits.sociability, 20); assert.equal(pending.after, 18);
  assert.throws(() => f.mind.review({ ...f.guard(), proposal_id: pending.id, revision: 999, decision: 'approve' }), /具体人格提议/);
  f.mind.review({ ...f.guard(), proposal_id: pending.id, revision: pending.revision, decision: 'approve' });
  assert.equal(f.mind.status().personality.traits.sociability, 18);
  appraise(f, 'd2b', { growth }); assert.equal(f.mind.status().growth.pending, null);
  assert.throws(() => appraise(f, 'overwrite', { profile: initial }), /缓慢成长/);
});

test('B applies only accumulated slow changes, corrections invalidate pending evidence, no mood editing API', () => {
  const f = fixture(), growth = { trait: 'optimism', direction: -1, reason: '对风险的关注逐步增强，并非价值变差' };
  f.mind.configure({ ...f.guard(), settings: { evolution_mode: 'experimental' } });
  appraise(f, 'a', { profile: initial, growth }); appraise(f, 'b', { growth }); f.tick(86400000); appraise(f, 'c', { growth });
  assert.equal(f.mind.status().personality.traits.optimism, 33);
  assert.equal(f.mind.status().growth.history[0].mode, 'experimental');
  assert.throws(() => f.mind.configure({ ...f.guard(), settings: { mood: 100 } }), /设置无效/);
  f.mind.correct({ ...f.guard(), event_id: 'a', explanation: '那一段是在引用小说，不是亲历。' });
  assert.equal(f.mind.load().events.find(e => e.id === 'a').corrected, true);
  assert.equal(f.mind.pending().at(-1).source, 'correction');
});

test('identity switching and restart isolate records, uncertain proactive delivery never repeats', async () => {
  const f = fixture(); appraise(f, 'a', { contact: { text: '今天想分享一件事', reason: '完成了有意义的小目标' } });
  let calls = 0; await f.mind.deliverContact(async () => { calls++; throw new Error('unknown write'); });
  const reopened = new CompanionMind(f.options);
  assert.equal(reopened.contactDue(), null); assert.equal(calls, 1);
  f.change({ base_url: 'http://localhost:4999', actor_id: 'a2', memory_dir: 'X:/test/companion-two' });
  assert.equal(f.mind.status().timeline.length, 0); assert.equal(f.mind.status().enabled, false);
  assert.throws(() => f.mind.configure({ expected_actor_id: 'a1', expected_base_url: 'http://localhost:4999', settings: { enabled: true } }), /已切换/);
});

test('background appraisal consumes existing cumulative budget, reuses completed output and preserves failed state', async () => {
  const f = fixture(); f.mind.noteEvent({ id: 'e', source: 'friend', summary: '收到了好友申请' });
  let calls = 0;
  const runtime = { mind: f.mind, mode: 'watch', abort: new AbortController(), isHostIdle: () => true, preferences: {},
    state: { model_calls: 9 }, limits: { max_model_calls: 10 }, stateFile: 'one', wallNow: f.now,
    checkActive() {}, budget() { assert.ok(this.state.model_calls < 10); }, commit(x) { Object.assign(this.state, x); },
    configuration: async () => ({ description: '谨慎但愿意交朋友' }), phaseTo() {}, noteModelCall() {},
    mindModel: async context => { calls++; return { event_ids: context.events.map(e => e.id), summary: '期待认识新朋友', reflection: '先了解对方', delta: { mood: 2 } }; } };
  assert.equal(await serviceMind(runtime), true); assert.equal(runtime.state.model_calls, 10); assert.equal(calls, 1);
  f.tick(3600000); f.mind.noteEvent({ id: 'e2', source: 'friend', summary: '另一个新消息' });
  assert.equal(await serviceMind(runtime), false); assert.equal(calls, 1);
  runtime.limits.max_model_calls = 11; runtime.budget = () => {}; runtime.mindModel = async () => { calls++; throw new Error('provider failed'); };
  const previous = f.mind.viewCurrent().values.mood;
  await serviceMind(runtime); assert.equal(runtime.state.model_calls, 11); assert.equal(f.mind.viewCurrent().values.mood, previous);
  assert.equal(new CompanionMind(f.options).pending().length, 0);
});

test('interrupted calls stay charged and their evidence is not retried in a different batch', () => {
  const f = fixture(); f.mind.noteEvent({ id: 'before-crash', source: 'friend', summary: '一件尚未回想的新经历' });
  assert.equal(f.mind.beginAttempt('one', ['before-crash']), true);
  const reopened = new CompanionMind(f.options);
  assert.equal(reopened.status().usage.calls, 1);
  assert.equal(reopened.status().usage.unknown_usage_calls, 1);
  assert.equal(reopened.load().attempts.one.status, 'interrupted');
  assert.equal(reopened.pending().length, 0);
  reopened.noteEvent({ id: 'after-crash', source: 'friend', summary: '后来的一件新经历' });
  assert.deepEqual(reopened.pending().map(e => e.id), ['after-crash']);
  assert.equal(new CompanionMind(f.options).status().usage.unknown_usage_calls, 1);
});

test('two calendar dates alone cannot cause growth; exact latest change can be undone once', () => {
  const f = fixture(), growth = { trait: 'optimism', direction: 1, reason: '在不同经历中逐步尝试积极解释' };
  f.tick(11 * 3600000 + 59 * 60000);
  appraise(f, 'late-a', { profile: initial, growth }); appraise(f, 'late-b', { growth });
  f.tick(2 * 60000); appraise(f, 'midnight', { growth });
  assert.equal(f.mind.status().growth.pending, null);
  f.tick(86400000); appraise(f, 'next-day', { growth });
  const pending = f.mind.status().growth.pending;
  f.mind.review({ ...f.guard(), proposal_id: pending.id, revision: pending.revision, decision: 'approve' });
  const revision = f.mind.status().personality.revision;
  f.mind.restoreGrowth({ ...f.guard(), proposal_id: pending.id, revision });
  assert.equal(f.mind.status().personality.traits.optimism, initial.traits.optimism);
  assert.equal(f.mind.status().growth.history[0].status, 'restored');
  assert.throws(() => f.mind.restoreGrowth({ ...f.guard(), proposal_id: pending.id, revision }), /最近一次/);
});

test('normal deferral needs approval; high autonomy retains same-session tasks across restart and never executes them', () => {
  const f = fixture(); f.mind.registerSession({ id: 'one' });
  const event = f.mind.noteDialog({ session_id: 'one', event_id: 'request1', role: 'user', text: '有空时整理这次活动' });
  const input = { event_id: event.id, summary: '整理活动', reason: '希望先休息再整理', resume_at: new Date(f.now() + 3600000).toISOString(), urgency: 'nonurgent' };
  const { task } = f.mind.deferTask(input, { session_id: 'one' });
  assert.equal(task.status, 'pending_approval');
  assert.equal(f.mind.deferTask(input, { session_id: 'one' }).duplicate, true);
  assert.throws(() => f.mind.deferTask(input, { session_id: 'two' }), /当前会话/);
  f.mind.reviewTask({ ...f.guard(), task_id: task.id, revision: task.revision, decision: 'approve' });
  f.tick(3600001);
  const reopened = new CompanionMind(f.options);
  assert.equal(reopened.context('one').deferred_tasks[0].status, 'due');
  assert.equal(reopened.context('two').deferred_tasks.length, 0);
  assert.equal(reopened.status().usage.calls, 0);
  reopened.completeTask({ task_id: task.id, reason: '已在原会话整理并交给用户' }, { session_id: 'one' });
  assert.equal(reopened.status().tasks[0].status, 'completed');
  reopened.configure({ ...f.guard(), settings: { high_autonomy: true } });
  const second = reopened.noteDialog({ session_id: 'one', event_id: 'request2', role: 'user', text: '稍后再分享一个感想' });
  const next = reopened.deferTask({ ...input, event_id: second.id, resume_at: new Date(f.now() + 3600000).toISOString() }, { session_id: 'one' });
  assert.equal(next.task.status, 'deferred');
  reopened.reviewTask({ ...f.guard(), task_id: next.task.id, revision: 0, decision: 'cancel' });
  assert.equal(reopened.status().tasks[1].status, 'cancelled');
});

test('proactive contact respects cross-midnight spacing and excluded or corrected evidence', async () => {
  const f = fixture(); f.tick(11 * 3600000 + 59 * 60000);
  const contact = { text: '有件小事想分享', reason: '确有新的共同话题' };
  appraise(f, 'night', { contact }); await f.mind.deliverContact(async () => {});
  f.tick(2 * 60000); appraise(f, 'after-midnight', { contact });
  assert.equal(f.mind.contactDue(), null);
  f.tick(4 * 3600000);
  assert.equal(f.mind.contactDue().event_ids[0], 'after-midnight');
  f.mind.correct({ ...f.guard(), event_id: 'after-midnight', explanation: '这里有误会，不应按原话联系。' });
  assert.equal(f.mind.contactDue(), null);
  const e = f.mind.noteDialog({ session_id: 'excluded', event_id: 'm', role: 'user', text: '私人临时会话' });
  f.mind.recordAppraisal({ event_ids: [e.id], summary: '', reflection: '', contact }, { session_id: 'excluded' });
  f.mind.session({ ...f.guard(), session_id: 'excluded', included: false });
  assert.equal(f.mind.contactDue(), null);
});

test('temporary rest suppresses autonomous browsing and drafting without treating community time as rest', () => {
  const f = fixture(), runtime = { mind: f.mind, wallNow: f.now };
  appraise(f, 'rest-now', { rest_minutes: 5, next_activity: 'rest' });
  assert.equal(mindResting(runtime), true);
  f.tick(5 * 60000); assert.equal(mindResting(runtime), false);
  appraise(f, 'community-now', { rest_minutes: 5, next_activity: 'observe' });
  assert.equal(mindResting(runtime), false);
});
