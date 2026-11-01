import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const binding = (id = 'ai-a') => ({ binding: { actorId: id, actorName: '伙伴' }, platformUrl: 'https://community.example/' });
const textOf = n => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : (n.children || []).map(textOf).join('');
function all(n, check, rows = []) {
  if (!n || typeof n !== 'object') return rows;
  if (Array.isArray(n)) { n.forEach(x => all(x, check, rows)); return rows; }
  if (check(n)) rows.push(n); (n.children || []).forEach(x => all(x, check, rows)); return rows;
}

function harness(capture, props, intercept) {
  let factory, Component, current = props, cursor = 0, dirty = true, tree, pending = [];
  const hooks = [], calls = [];
  const React = {
    createElement: (type, properties, ...children) => ({ type, props: properties || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, next => { const value = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; return hooks[i] ||= { current: value }; },
    useEffect(effect, deps) { const i = cursor++, old = hooks[i]; if (!old || deps.some((x, index) => !Object.is(x, old.deps[index]))) pending.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: effect() }; }); },
  };
  const anchor = "    return { inject: ['slots']";
  assert.equal(source.split(anchor).length, 2);
  vm.runInNewContext(source.replace(anchor, `    __capture(${capture});\n` + anchor), {
    URL, AbortController, console, Date, Intl, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: { randomUUID: () => 'test-life-editor' },
    window: { __ModuleLoader__: { load(v) { factory = v.factory; } } },
    __capture: value => { Component = value; },
    fetch: async (url, options) => { const call = { url, ...options, body: JSON.parse(options.body) }; calls.push(call); return intercept ? intercept(call) : { ok: true, json: async () => ({}) }; },
  });
  factory(() => React);
  const render = () => { dirty = false; cursor = 0; pending = []; tree = Component(current); pending.forEach(fn => fn()); return tree; };
  const flush = async () => { for (let n = 0; n < 12; n++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); return tree; };
  return { render, flush, calls, text: () => textOf(tree), nodes: check => all(tree, check),
    setProps(next) { current = next; dirty = true; return render(); },
    dispose() { hooks.forEach(hook => hook?.cleanup?.()); } };
}

test('life action wrapper sends exact identity and updates only the matching current partner', async () => {
  const updated = [], state = binding();
  const ui = harness('({state,setState}) => useCompanionAction(state,setState)', { state, setState: value => updated.push(value) },
    async call => ({ ok: true, json: async () => ({ ...state, companion: { identity: { actor_id: 'ai-a', base_url: 'https://community.example' }, enabled: true } }) }));
  const action = ui.render();
  await action({ action: 'life_settings', settings: { enabled: true }, expected_actor_id: 'ai-a', expected_base_url: 'https://community.example' });
  assert.equal(updated.length, 1); assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].credentials, 'same-origin'); assert.equal(ui.calls[0].redirect, 'error');
  assert.equal(ui.calls[0].body.action, 'life_settings');
  await assert.rejects(action({ action: 'life_settings', expected_actor_id: 'ai-b', expected_base_url: 'https://community.example' }), /life_identity_changed/);
  assert.equal(ui.calls.length, 1);
});

const lifeState = (id = 'ai-a') => ({ ...binding(id), companion: {
  identity: { actor_id: id, base_url: 'https://community.example' }, enabled: false,
  settings: { enabled: false, high_autonomy: false, evolution_mode: 'approval', proactive_enabled: false, quiet_start: '23:00', quiet_end: '08:00', contact_daily_limit: 2 },
  current: { summary: '今天想先私下聊一聊。', values: { mood: 55, pressure: 36, energy: 64 }, activities: { private: 80, reflect: 70 }, updated_at: '2026-11-01T06:00:00Z' },
  personality: { revision: 4, traits: { sociability: 40 } }, growth: { pending: null, history: [] },
  timeline: [{ id: 'event-a,event-b', at: '2026-11-01T06:00:00Z', source: 'community', summary: '同伴讨论新画作。', reflection: '我想先听听他们的创作思路。' }],
  sessions: [{ id: 'private-session-a', name: '和提督聊天', included: true }], tasks: [], rest: null, error: null, timezone: 'Asia/Shanghai',
  usage: { calls: 3, input_tokens: 1200, output_tokens: 240, unknown_usage_calls: 1 }
} });
const button = (ui, label) => ui.nodes(n => n.type === 'button' && textOf(n) === label)[0];
const checkbox = (ui, label) => all(ui.nodes(n => n.type === 'label' && textOf(n).startsWith(label))[0], n => n.type === 'input')[0];
const settingsSave = ui => button(ui, '保存相处设置');

test('life panel keeps private state hidden for absent or mismatched companion identity', t => {
  const state = lifeState(), ui = harness('CompanionLifePanel', { state, action: () => {} }); t.after(() => ui.dispose());
  ui.render(); assert.match(ui.text(), /今天想先私下聊一聊/);
  ui.setProps({ state: { ...state, companion: { ...state.companion, identity: { actor_id: 'ai-other', base_url: 'https://community.example' } } } });
  assert.match(ui.text(), /已隐藏近况/); assert.doesNotMatch(ui.text(), /今天想先私下|同伴讨论|和提督聊天/);
  ui.setProps({ state: binding() }); assert.match(ui.text(), /尚未加载伙伴近况/);
  ui.setProps({ state: {} }); assert.equal(ui.text(), '');
});

test('life panel is descriptive, disabled on upgrade, and does not invoke a model by rendering', t => {
  const actions = [], state = lifeState(), ui = harness('CompanionLifePanel', { state, action: payload => actions.push(payload) }); t.after(() => ui.dispose());
  ui.render();
  assert.match(ui.text(), /只纳入新经历，不会扫描旧聊天/);
  assert.match(ui.text(), /公开安静也可以有丰富的思考和私下交流/);
  assert.match(ui.text(), /不是 DSH 的全部用量/); assert.match(ui.text(), /1 次调用没有返回完整用量/);
  assert.match(ui.text(), /Asia\/Shanghai/); assert.match(ui.text(), /和提督聊天/);
  assert.equal(ui.nodes(n => n.type === 'input' && n.props.type === 'range').length, 0);
  assert.equal(checkbox(ui, '启用伙伴状态').props.checked, false);
  assert.equal(checkbox(ui, '高自主').props.checked, false);
  assert.equal(settingsSave(ui).props.disabled, true); assert.equal(actions.length, 0);
});

test('unsaved settings survive polling, hold updates, and do not follow another partner', async t => {
  const state = lifeState(), ui = harness('CompanionLifePanel', { state, action: () => {} }); t.after(() => ui.dispose());
  ui.render(); checkbox(ui, '高自主').props.onChange({ target: { checked: true } }); await ui.flush();
  assert.equal(checkbox(ui, '高自主').props.checked, true); assert.equal(settingsSave(ui).props.disabled, false);
  assert.equal(ui.calls.some(call => call.body.action === 'update_hold' && call.body.editing === true), true);
  ui.setProps({ state: JSON.parse(JSON.stringify(state)), action: () => {} });
  assert.equal(checkbox(ui, '高自主').props.checked, true);
  ui.setProps({ state: lifeState('ai-b'), action: () => {} });
  assert.equal(checkbox(ui, '高自主').props.checked, false); assert.equal(settingsSave(ui).props.disabled, true);
});

test('zero contact limit and experimental mode require explicit save with exact identity', async t => {
  let state = lifeState(); const actions = [];
  const action = async payload => { actions.push(payload); state = { ...state, companion: { ...state.companion, settings: { ...state.companion.settings, ...payload.settings } } }; return state; };
  const ui = harness('CompanionLifePanel', { state, action }); t.after(() => ui.dispose()); ui.render();
  ui.nodes(n => n.type === 'input' && n.props.type === 'number')[0].props.onChange({ target: { value: '0' } });
  ui.nodes(n => n.type === 'select')[0].props.onChange({ target: { value: 'experimental' } }); await ui.flush();
  assert.equal(actions.length, 0); assert.match(ui.text(), /无需逐次审批，可能在未逐次知情时导致人设长期改变/);
  settingsSave(ui).props.onClick(); await ui.flush();
  assert.equal(actions.length, 1); assert.equal(actions[0].action, 'life_settings');
  assert.equal(actions[0].settings.contact_daily_limit, 0); assert.equal(actions[0].settings.evolution_mode, 'experimental');
  assert.equal(actions[0].expected_actor_id, 'ai-a'); assert.equal(actions[0].expected_base_url, 'https://community.example');
  assert.match(ui.text(), /相处设置已保存/);
});

test('settings save without matching response is not acknowledged and draft remains', async t => {
  const state = lifeState(), ui = harness('CompanionLifePanel', { state, action: async () => state }); t.after(() => ui.dispose()); ui.render();
  checkbox(ui, '高自主').props.onChange({ target: { checked: true } }); await ui.flush();
  settingsSave(ui).props.onClick(); await ui.flush();
  assert.match(ui.text(), /未保存/); assert.doesNotMatch(ui.text(), /相处设置已保存/);
  assert.equal(checkbox(ui, '高自主').props.checked, true);
  ui.setProps({ state, action: async () => { throw new Error('private upstream text'); } });
  settingsSave(ui).props.onClick(); await ui.flush(); assert.doesNotMatch(ui.text(), /private upstream text/);
});

test('growth review uses the displayed proposal revision and rejects an unchanged pending proposal', async t => {
  const state = lifeState(), actions = [];
  state.companion.growth.pending = { id: 'growth-a', revision: 4, trait: 'sociability', before: 40, after: 41, reason: '几天相处的积累。', evidence: [{ id: 'ev-a', date: '2026-11-01', summary: '愿意先听完再回应。' }] };
  const ui = harness('CompanionLifePanel', { state, action: async payload => { actions.push(payload); return state; } }); t.after(() => ui.dispose()); ui.render();
  button(ui, '同意这次变化').props.onClick(); await ui.flush();
  assert.equal(actions[0].proposal_id, 'growth-a'); assert.equal(actions[0].revision, 4); assert.equal(actions[0].decision, 'approve');
  assert.match(ui.text(), /未保存/); assert.doesNotMatch(ui.text(), /已记录这次决定/);
  ui.setProps({ state, action: async () => ({ ...state, companion: { ...state.companion, growth: { ...state.companion.growth, pending: { ...state.companion.growth.pending, revision: 5 } } } }) });
  button(ui, '同意这次变化').props.onClick(); await ui.flush();
  assert.match(ui.text(), /未保存/); assert.doesNotMatch(ui.text(), /已记录这次决定/);
  ui.setProps({ state, action: async payload => { actions.push(payload); return { ...state, companion: { ...state.companion, growth: { ...state.companion.growth, pending: null } } }; } });
  button(ui, '暂不采用').props.onClick(); await ui.flush(); assert.equal(actions[1].decision, 'reject'); assert.match(ui.text(), /已记录这次决定/);
});

test('correction preserves the appraisal id and sessions preserve their own inclusion choice', async t => {
  const state = lifeState(), actions = [];
  const ui = harness('CompanionLifePanel', { state, action: async payload => {
    actions.push(payload);
    if (payload.action === 'life_session') return { ...state, companion: { ...state.companion, sessions: [{ ...state.companion.sessions[0], included: payload.included }] } };
    return state;
  } }); t.after(() => ui.dispose()); ui.render();
  button(ui, '补充解释').props.onClick(); await ui.flush();
  ui.nodes(n => n.type === 'textarea')[0].props.onChange({ target: { value: '  当时只是讨论画法，没有忽视你。  ' } }); await ui.flush();
  button(ui, '提交补充解释').props.onClick(); await ui.flush();
  assert.equal(actions[0].event_id, 'event-a,event-b'); assert.equal(actions[0].explanation, '当时只是讨论画法，没有忽视你。');
  assert.match(ui.text(), /补充解释已提交/); assert.match(ui.text(), /同伴讨论新画作/);
  checkbox(ui, '和提督聊天').props.onChange({ target: { checked: false } }); await ui.flush();
  assert.equal(actions[1].action, 'life_session'); assert.equal(actions[1].session_id, 'private-session-a'); assert.equal(actions[1].included, false);
  assert.match(ui.text(), /会话纳入选择已保存/);
});

test('growth history shows applied, rejected and corrected records from the server fields', t => {
  const state = lifeState(); state.companion.growth.history = [
    { id: 'a', trait: 'sociability', before: 40, after: 41, status: 'applied', mode: 'experimental', applied_at: '2026-11-01T04:00:00Z' },
    { id: 'b', trait: 'sociability', before: 41, after: 42, status: 'rejected', reviewed_at: '2026-11-01T05:00:00Z' },
    { id: 'c', trait: 'sociability', before: 41, after: 42, status: 'evidence_corrected', reviewed_at: '2026-11-01T06:00:00Z' }
  ];
  const ui = harness('CompanionLifePanel', { state, action: () => {} }); t.after(() => ui.dispose()); ui.render();
  assert.match(ui.text(), /试验模式自动采用/); assert.match(ui.text(), /暂不采用/); assert.match(ui.text(), /依据已补充解释/);
  assert.doesNotMatch(ui.text(), /日期未提供/);
});

test('a reply remains stale even when switching away and back to the same partner', async () => {
  let finish; const updated = [], setState = next => updated.push(next);
  const ui = harness('({state,setState}) => useCompanionAction(state,setState)', { state: binding(), setState },
    () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => lifeState() }); }));
  const request = ui.render()({ action: 'life_status', expected_actor_id: 'ai-a', expected_base_url: 'https://community.example' });
  ui.setProps({ state: binding('ai-b'), setState }); ui.setProps({ state: binding(), setState }); finish();
  await assert.rejects(request, /life_identity_changed/); assert.equal(updated.length, 0); ui.dispose();
});

test('only the currently applied personality change can be restored and the exact restore is verified', async t => {
  const state = lifeState(), actions = [];
  state.companion.growth.history = [
    { id: 'later-rejected', status: 'rejected', trait: 'sociability', before: 40, after: 41, revision: 4 },
    { id: 'current-change', status: 'applied', trait: 'sociability', before: 39, after: 40, resulting_revision: 4 },
    { id: 'older-change', status: 'applied', trait: 'sociability', before: 38, after: 39, resulting_revision: 3 }
  ];
  let response = state;
  const ui = harness('CompanionLifePanel', { state, action: async payload => { actions.push(payload); return response; } }); t.after(() => ui.dispose()); ui.render();
  assert.equal(ui.nodes(n => n.type === 'button' && textOf(n) === '撤回这次变化').length, 1);
  assert.match(ui.text(), /只撤回当前这次性格变化/);
  button(ui, '撤回这次变化').props.onClick(); await ui.flush();
  assert.equal(actions[0].action, 'life_growth_restore'); assert.equal(actions[0].proposal_id, 'current-change'); assert.equal(actions[0].revision, 4);
  assert.equal(actions[0].expected_actor_id, 'ai-a'); assert.equal(actions[0].expected_base_url, 'https://community.example');
  assert.match(ui.text(), /未保存/);
  response = { ...state, companion: { ...state.companion, personality: { ...state.companion.personality, revision: 5 } } };
  button(ui, '撤回这次变化').props.onClick(); await ui.flush();
  assert.match(ui.text(), /未保存/); assert.doesNotMatch(ui.text(), /已撤回这次性格变化/);
  response = { ...response, companion: { ...response.companion, growth: { ...state.companion.growth, history: state.companion.growth.history.map(item => item.id === 'current-change' ? { ...item, status: 'restored', restored_revision: 5, restored_at: '2026-11-01T07:00:00Z' } : item) } } };
  button(ui, '撤回这次变化').props.onClick(); await ui.flush(); assert.match(ui.text(), /已撤回这次性格变化/);
  ui.setProps({ state: response, action: () => {} }); assert.equal(button(ui, '撤回这次变化'), undefined); assert.match(ui.text(), /已撤回/);
});

test('task decisions are explicit, revision-bound, duplicate-safe, and never start a model', async t => {
  const state = lifeState(), actions = [];
  state.companion.tasks = [{ id: 'task-a', summary: '稍后一起整理今天的想法。', reason: '先完成正在做的事。', resume_at: '2026-11-01T10:00:00Z', status: 'pending_approval', revision: 2 }];
  let nextStatus = 'deferred';
  const action = async payload => { actions.push(payload); return { ...state, companion: { ...state.companion, tasks: [{ ...state.companion.tasks[0], status: nextStatus, revision: 3 }] } }; };
  const ui = harness('CompanionLifePanel', { state, action }); t.after(() => ui.dispose()); ui.render();
  assert.equal(actions.length, 0); assert.match(ui.text(), /到期后会在原 DSH 会话下一轮对话中提醒，不会自行启动模型/);
  const approve = button(ui, '同意这项安排'); approve.props.onClick(); approve.props.onClick(); await ui.flush();
  assert.equal(actions.length, 1); assert.equal(actions[0].action, 'life_task_review'); assert.equal(actions[0].task_id, 'task-a'); assert.equal(actions[0].revision, 2); assert.equal(actions[0].decision, 'approve');
  assert.equal(actions[0].expected_actor_id, 'ai-a'); assert.match(ui.text(), /已保存这项安排/);
  nextStatus = 'rejected'; button(ui, '不采用这项安排').props.onClick(); await ui.flush();
  assert.equal(actions[1].decision, 'reject'); assert.match(ui.text(), /已记录不采用这项安排/);
});

test('deferred and due tasks can be cancelled, while unchanged or malformed acknowledgments fail', async t => {
  const state = lifeState(), actions = [];
  state.companion.tasks = [{ id: 'task-a', summary: '稍后再看', resume_at: '2026-11-01T10:00:00Z', status: 'due', revision: 2 }];
  let response = state;
  const ui = harness('CompanionLifePanel', { state, action: async payload => { actions.push(payload); return response; } }); t.after(() => ui.dispose()); ui.render();
  assert.equal(button(ui, '同意这项安排'), undefined); assert.match(ui.text(), /已到提醒时间/);
  button(ui, '取消待办').props.onClick(); await ui.flush(); assert.match(ui.text(), /未保存/); assert.equal(actions[0].decision, 'cancel');
  response = { ...state, companion: { ...state.companion, tasks: [{ ...state.companion.tasks[0], status: 'cancelled', revision: 3 }] } };
  button(ui, '取消待办').props.onClick(); await ui.flush(); assert.match(ui.text(), /这项待办已取消/);
  ui.setProps({ state: response, action: () => {} }); assert.equal(button(ui, '取消待办'), undefined);
  ui.setProps({ state: { ...state, companion: { ...state.companion, tasks: [{ ...state.companion.tasks[0], revision: undefined }] } }, action: () => {} });
  assert.equal(button(ui, '取消待办').props.disabled, true);
});

test('life restore and task review mutations use the identity-protected request path', async t => {
  const state = lifeState(), updates = [];
  const ui = harness('({state,setState}) => useCompanionAction(state,setState)', { state, setState: value => updates.push(value) }, async () => ({ ok: true, json: async () => state })); t.after(() => ui.dispose());
  const action = ui.render(), identity = { expected_actor_id: 'ai-a', expected_base_url: 'https://community.example' };
  await action({ action: 'life_growth_restore', proposal_id: 'growth-a', revision: 4, ...identity });
  await action({ action: 'life_task_review', task_id: 'task-a', revision: 1, decision: 'approve', ...identity });
  assert.equal(ui.calls.length, 2); assert.equal(updates.length, 2);
  assert.deepEqual(ui.calls.map(call => call.body.action), ['life_growth_restore', 'life_task_review']);
  await assert.rejects(action({ action: 'life_task_review', task_id: 'task-a', revision: 1, decision: 'cancel', ...identity, expected_actor_id: 'ai-other' }), /life_identity_changed/);
  assert.equal(ui.calls.length, 2);
});

test('late life response cannot replace state after switching partner or unmounting', async () => {
  const updated = []; let finish;
  const ui = harness('({state,setState}) => useCompanionAction(state,setState)', { state: binding(), setState: value => updated.push(value) },
    () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => binding() }); }));
  const first = ui.render()({ action: 'life_status', expected_actor_id: 'ai-a', expected_base_url: 'https://community.example' });
  ui.setProps({ state: binding('ai-b'), setState: value => updated.push(value) }); finish();
  await assert.rejects(first, /life_identity_changed/); assert.equal(updated.length, 0);
  const second = ui.render()({ action: 'life_status', expected_actor_id: 'ai-b', expected_base_url: 'https://community.example' });
  ui.dispose(); finish(); await assert.rejects(second, /life_identity_changed/); assert.equal(updated.length, 0);
});

test('life controls reject duplicate dispatch, raw upstream errors and wrong response identity', async () => {
  let finish; const updated = [];
  const ui = harness('({state,setState}) => useCompanionAction(state,setState)', { state: binding(), setState: value => updated.push(value) },
    () => new Promise(resolve => { finish = result => resolve(result); }));
  const action = ui.render(), payload = { action: 'life_status', expected_actor_id: 'ai-a', expected_base_url: 'https://community.example' };
  const request = action(payload); await assert.rejects(action(payload), /life_action_unavailable/);
  finish({ ok: false, json: async () => ({ error: { message: 'private upstream detail' } }) });
  await assert.rejects(request, /^Error: life_action_failed$/); assert.equal(updated.length, 0);
  const wrong = action(payload); finish({ ok: true, json: async () => binding('ai-b') });
  await assert.rejects(wrong, /life_identity_changed/); assert.equal(updated.length, 0);
});
