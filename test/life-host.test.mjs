import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { setupLifeHost, memoryContextMatches, validateLifeAppraisal, validateLifeTask, LIFE_APPRAISAL_PARAMETERS, LIFE_TASK_PARAMETERS } from '../lib/life-host.js';
import { CompanionMind } from '../lib/companion-mind.js';

const MEMORY = resolve('.test-persona', 'shimakaze');
const boot = directory => ({ name: 'memory-boot', text: `长期记忆（dsh-plugin-memory）。记忆库位于 ${directory}。这是你跨会话的持久人格与记忆：\n伙伴人设` });
const human = (id, text, content = [{ type: 'text', text }]) => ({ id, role: 'user', source: { kind: 'user' }, content });
const assistant = (id, text, extra = {}) => ({ turn: 1, step: 1, message: { id, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }, ...extra });
const appraisal = ids => ({ event_ids: ids, summary: '相处愉快', reflection: '一起讨论角色让我感到亲近。', delta: { mood: 2 }, activities: { private: 75, public: 35 } });
const notice = (text, id = 'notice-message') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-plugin-tangui-life', form: 'notice', summary: '伙伴想和你聊聊' } });

function host({ mind: externalMind, createNoticeMessage } = {}) {
  const listeners = new Map(), contexts = new Map(), tools = new Map(), agents = new Map(), liveSessions = new Map(), effects = [];
  const state = { identity: { actor_id: 'actor-shima', base_url: 'https://community.invalid', memory_dir: MEMORY }, enabled: true,
    selectedDirectory: MEMORY, discoveryDirectory: MEMORY, discoveryStatus: 'ready', management: 'session-a', excluded: new Set(),
    settings: { proactive_enabled: true }, saved: [], registered: [], appraisals: [], archived: [], flushes: [], flushResult: true };
  const emit = (name, ...args) => { for (const fn of [...listeners.get(name) || []]) fn(...args); };
  const roots = () => [...agents.values()].filter(agent => !agent.parent);
  const addAgent = (id, { parent, origin, initialSeq = 50 } = {}) => {
    const session = { id, seq: initialSeq, header: { id, ...(origin ? { origin } : {}) }, writes: [], appendAttempts: 0,
      append(type, data, options) {
        this.appendAttempts++;
        if (this.appendError) throw new Error('PRIVATE_STORE_ERROR');
        const event = { type, data, seq: this.seq++, time: Date.now(), ...options };
        this.writes.push(event); emit('session/event', this, event); return event;
      },
      snapshotEvents() { throw new Error('HISTORY_MUST_NOT_BE_READ'); },
      eventAt() { throw new Error('HISTORY_MUST_NOT_BE_READ'); },
    };
    for (const key of ['history', 'messages', 'log']) Object.defineProperty(session, key, { get() { throw new Error('HISTORY_MUST_NOT_BE_READ'); } });
    const agent = { id, session, parent, status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
    agents.set(id, agent); liveSessions.set(id, session); emit('agent/created', { agent }); return agent;
  };
  const a = addAgent('session-a'), b = addAgent('session-b'), child = addAgent('session-child', { parent: a, origin: 'subagent' });
  const mind = externalMind || {
    activeIdentity: () => state.identity,
    enabled: () => state.enabled,
    status: () => ({ settings: state.settings }),
    registerSession(value) { state.registered.push(value); },
    isSessionIncluded: id => !state.excluded.has(id),
    noteDialog(value) {
      if (state.noteError) throw new Error('PRIVATE_NOTE_ERROR');
      const row = { ...value, id: `dialog:${value.session_id}:${value.event_id}` };
      if (!state.saved.some(item => item.id === row.id)) state.saved.push(row);
      return row;
    },
    prompt: id => `PRIVATE_CURRENT_STATE:${state.identity.actor_id}\n${JSON.stringify(state.saved.filter(row => row.session_id === id))}`,
    recordAppraisal(value, { session_id }) {
      for (const id of value.event_ids) {
        const row = state.saved.find(item => item.id === id);
        if (!row || row.session_id !== session_id) throw Object.assign(new Error('event mismatch'), { code: 'life_event_mismatch' });
      }
      state.appraisals.push({ value, session_id }); return { recorded: true };
    },
  };
  const services = {
    agents: { get: id => agents.get(id), roots },
    sessions: { get: id => liveSessions.get(id), async flush(session) {
      state.flushes.push(session.id); if (state.flushError) throw new Error('PRIVATE_FLUSH_ERROR'); return state.flushResult;
    } },
    workspaceRegistry: { get archivedSessionIds() { return state.archived; } },
    systemPrompt: { context(config) { contexts.set(config.name, config); return () => contexts.delete(config.name); } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  };
  const ctx = { ...services, get: name => services[name],
    on(name, fn) { let entries = listeners.get(name); if (!entries) listeners.set(name, entries = new Set()); entries.add(fn); return () => entries.delete(fn); },
    inject(_deps, fn) { fn(ctx); }, effect(setup) { effects.push(setup()); },
  };
  const adapter = setupLifeHost(ctx, { mind, bridge: { publicStatus: () => ({ memoryDir: state.selectedDirectory }) },
    discovery: () => ({ status: state.discoveryStatus, memoryDir: state.discoveryDirectory }),
    managementSession: { publicStatus: () => ({ sessionId: state.management }) }, createNoticeMessage: createNoticeMessage || (async text => notice(text)),
  });
  const assemble = async (agent = a, directory = MEMORY) => {
    const context = { agent }, contributions = [...contexts.values()].map(config => ({ name: config.name, text: config.text(context), interpolate: config.interpolate }));
    const base = { sections: [], tools: [], variables: {}, contexts: [...(directory ? [boot(directory)] : []), ...contributions] };
    const chain = [...listeners.get('system-prompt/assemble') || []];
    const run = index => index === chain.length ? Promise.resolve(base) : chain[index](base, context, () => run(index + 1));
    return run(0);
  };
  const message = (agent, data, type = 'user/message') => agent.session.append(type, data, { surfaceOp: 'append' });
  const user = (agent = a, id = 'new-user', text = '今天一起做点有意思的事吧。') => message(agent, human(id, text));
  const runTool = (value, agent = a, signal = new AbortController().signal) => tools.get('tangui_life').execute(value, { agent, signal });
  const runTask = (value, agent = a, signal = new AbortController().signal) => tools.get('tangui_life_task').execute(value, { agent, signal });
  const ready = async (agent = a, id = 'new-user') => { user(agent, id); await assemble(agent, state.identity.memory_dir); };
  const notices = () => [...liveSessions.values()].flatMap(session => session.writes).filter(event => event.data?.source?.kind === 'dsh-plugin-tangui-life');
  return { a, b, child, state, adapter, emit, assemble, message, user, runTool, runTask, ready, notices, addAgent, agents, liveSessions, listeners, contexts, tools, effects, mind };
}

function taskMind(t, highAutonomy = false) {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'life-host-task-'));
  t.after(() => { assert.ok(directory.startsWith(parent + sep)); rmSync(directory, { recursive: true }); });
  const identity = { actor_id: 'actor-shima', base_url: 'https://community.invalid', memory_dir: MEMORY };
  let now = Date.now();
  const mind = new CompanionMind({ directory, identity: () => identity, now: () => now });
  const guard = { expected_actor_id: identity.actor_id, expected_base_url: identity.base_url };
  mind.configure({ ...guard, settings: { enabled: true, high_autonomy: highAutonomy } });
  return { mind, guard, advance: milliseconds => { now += milliseconds; }, future: () => new Date(now + 3600000).toISOString() };
}

test('memory match requires the actual named memory contribution and exact normalized directory', () => {
  assert.equal(memoryContextMatches([boot(MEMORY)], MEMORY), true);
  assert.equal(memoryContextMatches([boot(MEMORY.toUpperCase())], MEMORY), true);
  for (const contexts of [[], [boot(MEMORY + '-other')], [{ ...boot(MEMORY), name: 'invented' }], [{ name: 'memory-boot', text: 'prefix ' + boot(MEMORY).text }]]) {
    assert.equal(memoryContextMatches(contexts, MEMORY), false);
  }
});

test('only new committed user and complete assistant text enter the verified same-persona session', async () => {
  const h = host();
  h.emit('session/event', h.a.session, { type: 'user/message', seq: 49, time: Date.now(), data: human('old', 'HISTORICAL_PRIVATE') });
  h.message(h.a, assistant('orphan', 'ORPHAN_ASSISTANT'), 'assistant/message');
  h.user();
  assert.equal(h.state.saved.length, 0, 'do not record until actual prompt persona verified');
  const assembly = await h.assemble();
  assert.match(assembly.contexts.find(item => item.name === 'tangui-companion-state').text, /PRIVATE_CURRENT_STATE:actor-shima/);
  assert.equal(h.state.saved.length, 1);
  h.message(h.a, assistant('assistant-1', '', { message: { id: 'assistant-1', content: [
    { type: 'reasoning', text: 'HIDDEN_REASONING' }, { type: 'tool-call', name: 'read_secret', args: 'TOOL_ARGUMENTS' }, { type: 'text', text: '和提督一起做这件事很开心。' },
  ] } }), 'assistant/message');
  h.message(h.a, assistant('interrupted', 'INCOMPLETE', { interrupted: true }), 'assistant/message');
  h.message(h.a, { id: 'tool-result', content: [{ type: 'text', text: 'TOOL_RESULT' }] }, 'tool/message');
  h.message(h.a, notice('SYNTHETIC_NOTICE'));
  const saved = JSON.stringify(h.state.saved);
  assert.equal(h.state.saved.length, 2);
  assert.equal(h.state.saved[1].role, 'assistant');
  assert.match(saved, /和提督一起/);
  for (const secret of ['HISTORICAL_PRIVATE', 'ORPHAN_ASSISTANT', 'HIDDEN_REASONING', 'TOOL_ARGUMENTS', 'INCOMPLETE', 'TOOL_RESULT', 'SYNTHETIC_NOTICE']) assert.ok(!saved.includes(secret));
  assert.equal(h.state.saved[0].id, 'dialog:session-a:dsh:session-a:new-user');
  assert.equal(h.adapter.status().ready_sessions, 1);
});

test('wrong persona, excluded sessions, subagents and diagnostic prompt previews never get state', async () => {
  const h = host(); h.user();
  assert.ok(!(await h.assemble(h.a, MEMORY + '-wrong')).contexts.some(item => item.name === 'tangui-companion-state'));
  assert.equal(h.state.saved.length, 0);
  h.user(h.child, 'child-user');
  assert.ok(!(await h.assemble(h.child)).contexts.some(item => item.name === 'tangui-companion-state'));
  h.state.excluded.add(h.b.id); h.user(h.b, 'excluded'); await h.assemble(h.b);
  assert.equal(h.state.saved.length, 0);
  await h.ready();
  assert.ok(!(await h.assemble(undefined, null)).contexts.some(item => item.name === 'tangui-companion-state'));
  const diagnostic = await h.assemble(null);
  assert.ok(!diagnostic.contexts.some(item => item.name === 'tangui-companion-state'));
  h.state.excluded.add(h.a.id);
  assert.ok(!(await h.assemble()).contexts.some(item => item.name === 'tangui-companion-state'));
  await assert.rejects(h.runTool(appraisal([h.state.saved[0].id])), error => error.code === 'life_session_unavailable');
});

test('same persona in multiple root sessions contributes once per committed message; listener never scans history', async () => {
  const h = host(); await h.ready(h.a, 'a-user'); await h.ready(h.b, 'b-user');
  assert.equal(h.state.saved.length, 2); assert.equal(h.adapter.status().ready_sessions, 2);
  const repeated = h.a.session.writes[0]; h.emit('session/event', h.a.session, repeated);
  assert.equal(h.state.saved.length, 2);
  const later = h.addAgent('session-later', { initialSeq: 1024 });
  await h.ready(later, 'later-user');
  assert.equal(h.state.saved.at(-1).session_id, later.id);
  assert.equal(h.adapter.status().ready_sessions, 3);
  h.agents.delete(later.id); h.emit('agent/disposed', { agent: later });
  assert.equal(h.adapter.status().ready_sessions, 2);
});

test('disabled and changed identities discard queued context and require newly verified persona', async () => {
  const h = host(); h.user(h.a, 'old-queued');
  h.state.enabled = false; await h.assemble();
  h.user(h.a, 'disabled-message');
  h.state.enabled = true; await h.ready(h.a, 'enabled-message');
  assert.deepEqual(h.state.saved.map(row => row.event_id), ['dsh:session-a:enabled-message']);
  h.state.identity = { ...h.state.identity, actor_id: 'actor-other', memory_dir: MEMORY + '-other' };
  h.state.selectedDirectory = h.state.discoveryDirectory = h.state.identity.memory_dir;
  h.user(h.a, 'other-persona');
  const wrong = await h.assemble(h.a, MEMORY);
  assert.ok(!wrong.contexts.some(item => item.name === 'tangui-companion-state'));
  h.user(h.a, 'other-verified'); const right = await h.assemble(h.a, h.state.identity.memory_dir);
  assert.match(right.contexts.find(item => item.name === 'tangui-companion-state').text, /actor-other/);
  assert.ok(!h.state.saved.some(row => row.event_id.endsWith('other-persona')));
  assert.ok(h.state.saved.some(row => row.event_id.endsWith('other-verified')));
  h.state.selectedDirectory = MEMORY;
  assert.equal(h.adapter.status().ready_sessions, 0);
  assert.equal(h.adapter.canDeliver(), false);
});

test('system prompt changes invalidate evidence; pinned discovery alone cannot authorize a mismatched active persona', async () => {
  const h = host(); await h.ready();
  h.emit('system-prompt/change');
  await assert.rejects(h.runTool(appraisal([h.state.saved[0].id])), error => error.code === 'life_session_unavailable');
  assert.ok(!(await h.assemble(h.a, MEMORY + '-not-actually-loaded')).contexts.some(item => item.name === 'tangui-companion-state'));
  h.user(h.a, 'matching-again'); await h.assemble();
  await h.runTool(appraisal([h.state.saved.at(-1).id]));
  assert.equal(h.state.appraisals.length, 1);
});

test('appraisals use core validation, cannot change settings or submit another session evidence', async () => {
  const h = host(); await h.ready(h.a, 'a'); await h.ready(h.b, 'b');
  const ids = [h.state.saved[0].id];
  for (const value of [ { ...appraisal(ids), settings: { high_autonomy: true } }, { ...appraisal(ids), delta: { mood: 11 } },
    { ...appraisal(ids), budget: 1000 }, { ...appraisal(ids), approve: true }, { ...appraisal(ids), growth: { trait: 'best', direction: 1, reason: 'invented' } } ]) {
    await assert.rejects(h.runTool(value), error => error.code === 'life_invalid_appraisal');
  }
  await assert.rejects(h.runTool(appraisal([h.state.saved[1].id])), error => error.code === 'life_event_mismatch');
  await assert.rejects(h.runTool(appraisal(['invented-event'])), error => error.code === 'life_event_mismatch');
  const full = { ...appraisal(ids), recovery_hours: { energy: 4, mood: 12 }, rest_minutes: 15, next_activity: 'reflect',
    profile: { traits: { sociability: 20, deliberation: 80 }, baselines: { mood: 55 }, activities: { private: 85 }, description: '安静而重视与熟人交流。' } };
  assert.deepEqual(validateLifeAppraisal(full), full);
  await h.runTool(full);
  assert.equal(h.state.appraisals.length, 1);
  assert.deepEqual(h.state.appraisals[0].value, full);
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(h.runTool(appraisal(ids), h.a, aborter.signal), error => error.name === 'AbortError');
  assert.equal(h.state.appraisals.length, 1);
  assert.equal(LIFE_APPRAISAL_PARAMETERS.properties.delta.properties.mood.maximum, 10);
  assert.equal(LIFE_APPRAISAL_PARAMETERS.properties.event_ids.maxItems, 12);
});

test('only designated management conversation can supply a research inspiration while other conversations retain feelings', async t => {
  const f = taskMind(t), h = host({ mind: f.mind });
  await h.ready(h.a, 'a'); await h.ready(h.b, 'b');
  const inspiration = { question: '合作游戏中的分工会怎样影响信任？', keywords: ['合作游戏', '信任'] };
  const managed = f.mind.pending(h.a.id)[0], other = f.mind.pending(h.b.id)[0];
  const ctxA = (await h.assemble(h.a)).contexts.find(c => c.name === 'tangui-companion-state').text;
  const ctxB = (await h.assemble(h.b)).contexts.find(c => c.name === 'tangui-companion-state').text;
  assert.match(ctxA, /本会话是指定管理者互动会话/);
  assert.match(ctxB, /不得附带研究 inspiration/);
  await assert.rejects(h.runTool({ ...appraisal([other.id]), inspiration }, h.b), { code: 'life_inspiration_session' });
  await h.runTool(appraisal([other.id]), h.b);
  await h.runTool({ ...appraisal([managed.id]), inspiration });
  assert.equal(h.adapter.researchSessionId(), h.a.id);
  assert.equal(f.mind.researchSeeds(h.a.id).length, 1);
  assert.equal(f.mind.researchSeeds(h.b.id).length, 0);
  assert.equal(f.mind.status().usage.calls, 0, 'saving the seed does not start an additional model call');
  assert.equal(LIFE_APPRAISAL_PARAMETERS.properties.inspiration.properties.keywords.maxItems, 5);
  h.state.management = h.b.id;
  assert.equal(h.adapter.researchSessionId(), h.b.id);
  h.user(h.a, 'a-next'); await h.assemble(h.a);
  const next = f.mind.pending(h.a.id)[0];
  await assert.rejects(h.runTool({ ...appraisal([next.id]), inspiration }), { code: 'life_inspiration_session' });
  f.mind.session({ ...f.guard, session_id: h.b.id, included: false });
  assert.equal(h.adapter.researchSessionId(), null);
  f.mind.session({ ...f.guard, session_id: h.b.id, included: true });
  h.state.selectedDirectory = MEMORY + '-different';
  assert.equal(h.adapter.researchSessionId(), null);
});

test('pending same-session experience from before restart remains usable under real core ownership checks', async t => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'life-host-'));
  t.after(() => { assert.ok(directory.startsWith(parent + sep)); rmSync(directory, { recursive: true }); });
  const identity = { actor_id: 'actor-shima', base_url: 'https://community.invalid', memory_dir: MEMORY };
  let mind = new CompanionMind({ directory, identity: () => identity });
  mind.configure({ expected_actor_id: identity.actor_id, expected_base_url: identity.base_url, settings: { enabled: true } });
  const original = mind.noteDialog({ session_id: 'session-a', event_id: 'dsh:session-a:prior-live-user', role: 'user', text: '昨天一起制作了一个小画面。', at: new Date().toISOString() });
  mind = new CompanionMind({ directory, identity: () => identity });
  const h = host({ mind }); await h.ready();
  const result = await h.runTool(appraisal([original.id]));
  assert.equal(result.saved, true);
  assert.equal(mind.pending('session-a').some(row => row.id === original.id), false);
  const foreign = mind.noteDialog({ session_id: 'session-b', event_id: 'dsh:session-b:private', role: 'user', text: '另一会话的内容。', at: new Date().toISOString() });
  await assert.rejects(h.runTool(appraisal([foreign.id])), error => error.code === 'life_event_mismatch');
});

test('task tool defaults to pending approval, deduplicates the human request and records completion only in its session', async t => {
  const f = taskMind(t), h = host({ mind: f.mind }); await h.ready();
  const event = f.mind.pending(h.a.id)[0];
  const input = { action: 'defer', event_id: event.id, summary: '整理今天讨论的绘图想法', reason: '希望稍后有充足时间再整理。', resume_at: f.future(), urgency: 'nonurgent' };
  const first = await h.runTask(input);
  assert.equal(first.task.status, 'pending_approval'); assert.match(first.notice, /尚未批准/); assert.match(first.notice, /优先完成当前请求/);
  assert.equal(f.mind.status().settings.high_autonomy, false);
  const second = await h.runTask(input);
  assert.equal(second.duplicate, true); assert.equal(second.task.id, first.task.id); assert.match(second.notice, /尚未批准/);
  assert.equal(f.mind.status().tasks.length, 1);
  f.advance(3600001);
  const context = (await h.assemble()).contexts.find(item => item.name === 'tangui-companion-state').text;
  assert.match(context, /整理今天讨论的绘图想法/); assert.match(context, /pending_approval/);
  assert.equal(f.mind.status().tasks[0].status, 'pending_approval', 'time passing does not approve a request');
  assert.equal(f.mind.status().usage.calls, 0);
  assert.equal(h.a.session.writes.length, 1); assert.equal(h.a.status, 'idle'); assert.equal(h.notices().length, 0);
  for (const invalid of [{ ...input, approved: true }, { ...input, action: 'approve' }, { action: 'complete', task_id: first.task.id }]) {
    await assert.rejects(h.runTask(invalid), error => error.code === 'life_task_invalid');
  }
  const completed = await h.runTask({ action: 'complete', task_id: first.task.id, reason: '已把讨论整理成三个具体绘图方案并交给用户。' });
  assert.equal(completed.task.status, 'completed');
  assert.equal(f.mind.context(h.a.id).deferred_tasks.length, 0);
  assert.equal(f.mind.status().settings.high_autonomy, false);
});

test('high-autonomy task deferral still rejects unknown, assistant, foreign, excluded or cancelled evidence', async t => {
  const f = taskMind(t, true), h = host({ mind: f.mind });
  await h.ready(h.a, 'human-a'); await h.ready(h.b, 'human-b');
  h.message(h.a, assistant('assistant-a', '我有一个想法。'), 'assistant/message');
  const [humanEvent, assistantEvent] = f.mind.pending(h.a.id), foreign = f.mind.pending(h.b.id)[0];
  const input = { action: 'defer', event_id: humanEvent.id, summary: '晚些时候整理插画方案', reason: '这项请求不着急，准备休息后再整理。', resume_at: f.future(), urgency: 'nonurgent' };
  for (const event_id of ['invented-event', foreign.id, assistantEvent.id]) {
    await assert.rejects(h.runTask({ ...input, event_id }), error => error.code === 'life_event_mismatch');
  }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(h.runTask(input, h.a, cancelled.signal), error => error.name === 'AbortError');
  await assert.rejects(h.runTask(input, h.child), error => error.code === 'life_session_unavailable');
  f.mind.session({ ...f.guard, session_id: h.a.id, included: false });
  await assert.rejects(h.runTask(input), error => error.code === 'life_session_unavailable');
  f.mind.session({ ...f.guard, session_id: h.a.id, included: true });
  h.user(h.a, 'human-back'); await h.assemble();
  assert.equal(f.mind.status().tasks.length, 0);
  const saved = await h.runTask(input);
  assert.equal(saved.task.status, 'deferred'); assert.match(saved.notice, /解释安排/);
  await assert.rejects(h.runTask({ action: 'complete', task_id: saved.task.id, reason: '不能从另一会话完成。' }, h.b), error => error.code === 'life_task_invalid');
  f.advance(3600001);
  const before = h.a.session.writes.length;
  assert.equal(f.mind.context(h.a.id).deferred_tasks[0].status, 'due');
  const context = (await h.assemble()).contexts.find(item => item.name === 'tangui-companion-state').text;
  assert.match(context, /"status":"due"/);
  assert.equal(h.a.session.writes.length, before); assert.equal(h.a.inbox.nextTurn.length, 0); assert.equal(h.a.inbox.nextStep.length, 0);
  assert.equal(f.mind.status().usage.calls, 0); assert.equal(h.notices().length, 0);
  const completed = await h.runTask({ action: 'complete', task_id: saved.task.id, reason: '已实际完成并给出了整理结果。' });
  assert.equal(completed.task.status, 'completed');
  f.mind.identitySource = () => ({ actor_id: 'other', base_url: 'https://community.invalid', memory_dir: MEMORY });
  await assert.rejects(h.runTask({ action: 'complete', task_id: saved.task.id, reason: '旧身份的待办。' }), error => error.code === 'life_session_unavailable');
});

test('task schema permits only defer/complete and validation refuses settings, budget, urgency and invalid times', () => {
  const input = { action: 'defer', event_id: 'dialog:session-a:dsh:session-a:human', summary: '整理画稿', reason: '稍后再整理。', resume_at: '2026-11-02T10:30:00+08:00', urgency: 'nonurgent' };
  assert.deepEqual(validateLifeTask(input), input);
  assert.deepEqual(LIFE_TASK_PARAMETERS.properties.action.enum, ['defer', 'complete']);
  assert.equal(LIFE_TASK_PARAMETERS.additionalProperties, false);
  for (const value of [null, [], { ...input, settings: {} }, { ...input, budget: 1000 }, { ...input, urgency: 'urgent' },
    { ...input, summary: 'x'.repeat(501) }, { ...input, reason: '' }, { ...input, resume_at: 'tomorrow' },
    { ...input, resume_at: '2026-11-02T10:30:00' }, { ...input, task_id: 'unrelated' },
    { action: 'complete', task_id: 'task-id', reason: '完成', event_id: input.event_id }, { action: 'approve', task_id: 'task-id', reason: '自行批准' }]) {
    assert.throws(() => validateLifeTask(value), error => error.code === 'life_task_invalid');
  }
});

test('proactive contact is a visible attributed notice, does not wake a model or count itself as experience', async () => {
  const h = host(); await h.ready();
  const before = h.state.saved.length;
  const result = await h.adapter.deliver('提督，刚刚的讨论让我想到一个有趣的故事。', 'contact-1');
  assert.deepEqual(result, { delivered: true, persisted: true, session_id: 'session-a', message_id: 'notice-message', event_seq: 51, notice_id: 'contact-1' });
  assert.deepEqual(h.state.flushes, ['session-a']);
  const [event] = h.notices();
  assert.equal(event.type, 'user/message'); assert.equal(event.surfaceOp, 'append');
  assert.equal(event.data.source.kind, 'dsh-plugin-tangui-life');
  assert.match(event.data.content[0].text, /^【伙伴主动留言】/);
  assert.equal(h.state.saved.length, before);
  assert.equal(h.a.status, 'idle'); assert.equal(h.a.inbox.nextTurn.length, 0); assert.equal(h.a.inbox.nextStep.length, 0);
});

test('proactive notice requires selected live, included, verified idle session and does not interrupt another root', async () => {
  const mutations = [
    h => { h.state.management = null; }, h => { h.state.management = h.child.id; }, h => { h.state.excluded.add(h.a.id); },
    h => { h.state.settings.proactive_enabled = false; }, h => { h.state.archived.push(h.a.id); },
    h => { h.a.status = 'running'; }, h => { h.b.status = 'running'; }, h => { h.b.inbox.nextStep.push({}); },
    h => { h.a.inbox.nextTurn.push({}); }, h => { h.liveSessions.delete(h.a.id); },
    h => { h.emit('system-prompt/change'); }, h => { h.state.enabled = false; },
  ];
  for (const mutate of mutations) {
    const h = host(); await h.ready(); mutate(h);
    assert.equal(h.adapter.canDeliver(), false);
    await assert.rejects(h.adapter.deliver('想分享一点近况。', 'contact-1'), error => error.code === 'life_contact_unavailable');
    assert.equal(h.notices().length, 0);
  }
  const h = host(); await h.ready(h.a, 'a'); await h.ready(h.b, 'b'); h.state.management = h.b.id;
  assert.equal((await h.adapter.deliver('这条给选中的会话。', 'contact-b')).session_id, h.b.id);
});

test('identity, management selection or busy-state change during async notice creation cancels delivery', async () => {
  for (const mutate of [h => { h.state.management = h.b.id; }, h => { h.state.identity = { ...h.state.identity, actor_id: 'new-actor' }; }, h => { h.a.status = 'running'; }]) {
    let release; const barrier = new Promise(done => { release = done; });
    const h = host({ createNoticeMessage: async text => { await barrier; return notice(text); } });
    await h.ready(h.a, 'a'); await h.ready(h.b, 'b');
    const pending = h.adapter.deliver('切换前的想法。', 'contact-1');
    await Promise.resolve(); mutate(h); release();
    await assert.rejects(pending, error => error.code === 'life_contact_changed');
    assert.equal(h.notices().length, 0);
  }
});

test('concurrent and repeated contact IDs never duplicate; flush failure reports already visible delivery', async () => {
  let created = 0;
  const h = host({ createNoticeMessage: async text => { created++; return notice(text); } });
  await h.ready(h.a, 'a'); await h.ready(h.b, 'b'); h.state.flushError = true;
  const [one, two] = await Promise.all([h.adapter.deliver('值得分享的事。', 'once'), h.adapter.deliver('重复文本不应再次发出。', 'once')]);
  assert.deepEqual(one, two); assert.equal(one.persisted, false); assert.equal(one.delivered, true);
  assert.equal(created, 1); assert.equal(h.notices().length, 1); assert.equal(h.state.flushes.length, 1);
  assert.equal(h.adapter.status().error, 'life_contact_flush_failed');
  assert.ok(!JSON.stringify(h.adapter.status()).includes('PRIVATE_FLUSH_ERROR'));
  h.state.management = h.b.id;
  assert.equal((await h.adapter.deliver('更换管理会话也不能重复发。', 'once')).session_id, h.a.id);
  assert.equal(h.notices().length, 1);
});

test('append failure is sanitized and repeated failed ID is not retried', async () => {
  const h = host(); await h.ready(); h.a.session.appendError = true;
  const before = h.a.session.appendAttempts;
  for (let i = 0; i < 2; i++) await assert.rejects(h.adapter.deliver('想分享的话。', 'uncertain'), error => error.code === 'life_contact_append_failed' && !error.message.includes('PRIVATE_STORE_ERROR'));
  assert.equal(h.a.session.appendAttempts - before, 1);
  assert.equal(h.notices().length, 0);
});

test('observation failures preserve ordinary messages and disposal removes listeners, contexts and tools', async () => {
  const h = host(); await h.ready(); h.state.noteError = true;
  assert.doesNotThrow(() => h.user(h.a, 'disk-failure'));
  assert.equal(h.adapter.status().error, 'life_dialog_save_failed');
  assert.equal(h.a.session.writes.at(-1).data.id, 'disk-failure');
  h.adapter.dispose(); h.adapter.dispose();
  assert.equal([...h.listeners.values()].reduce((n, entries) => n + entries.size, 0), 0);
  assert.equal(h.contexts.size, 0); assert.equal(h.tools.size, 0);
  assert.equal(h.adapter.status().ready_sessions, 0); assert.equal(h.adapter.canDeliver(), false);
});
