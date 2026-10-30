import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual chat-slot component, including its network and navigation
// boundaries. No real session, model, community or credential is used.
function page(initial, sessionId = 'session-current', visible = true, slot = 'conversation.input.dock') {
  let factory, current, state = initial, failed = false, serial = 0;
  const components = new Map(), timers = new Map(), requests = [], opened = [];
  const storage = new Map([['tangui-management-card-visible', visible ? 'on' : 'off']]), storageListeners = new Set();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const owner = current, i = owner.index++; owner.hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [owner.hooks[i].value, value => { owner.hooks[i].value = typeof value === 'function' ? value(owner.hooks[i].value) : value; }]; },
    useRef(value) { return current.hooks[current.index++] ||= { current: value }; },
    useEffect(effect, deps) { const owner = current, i = owner.index++, old = owner.hooks[i];
      if (!old || deps.some((v, n) => v !== old.deps[n])) owner.effects.push(() => { old?.cleanup?.(); owner.hooks[i] = { deps, cleanup: effect() }; }); },
  };
  vm.runInNewContext(readFileSync('client.js', 'utf8'), {
    URL, window: { __ModuleLoader__: { load(v) { factory = v.factory; } },
      addEventListener(name, callback) { if (name === 'storage') storageListeners.add(callback); },
      removeEventListener(name, callback) { if (name === 'storage') storageListeners.delete(callback); } }, AbortController,
    crypto: { randomUUID: () => 'test-observation-uuid' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { return setTimeout(fn, ms); }, clearInterval(id) { clearTimeout(id); },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (failed) throw new Error('private upstream message must not display');
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.equal(body.action, 'management_bind');
        state = { ...state, managementSession: { sessionId: body.sessionId } };
      }
      return { ok: true, json: async () => structuredClone(state) };
    },
  });
  factory(() => React).apply({ slots: { inject(_name, callback) { callback(); }, register(config, Component) { components.set(config.name, Component); } },
    get(name) { assert.equal(name, 'uiWorkspace'); return { openSession(id) { opened.push(id); } }; } });
  const Component = components.get(slot);
  assert.ok(Component);
  const owner = { hooks: [], index: 0, effects: [] };
  const render = () => { current = owner; owner.index = 0; owner.effects = []; const tree = slot === 'settings.section' ? Component({}) : Component({ sessionId }); owner.effects.forEach(f => f()); return tree; };
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); return render(); };
  return { render, settle, requests, opened, setState(value) { state = value; }, fail(value) { failed = value; },
    mount(node) { const sub = { hooks: [], index: 0, effects: [] }; current = sub; const tree = node.type(node.props); sub.effects.forEach(f => f()); return tree; },
    visibility(value) { storage.set('tangui-management-card-visible', value ? 'on' : 'off'); for (const listener of storageListeners) listener({ key: 'tangui-management-card-visible' }); },
    async poll() { const next = [...timers].find(([, value]) => value.ms === 5000); assert.ok(next); timers.delete(next[0]); await next[1].fn(); return settle(); },
    dispose() { owner.hooks.forEach(hook => hook.cleanup?.()); }, timers };
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children || []).map(text).join(' ');
function find(node, predicate) { if (!node || typeof node !== 'object') return null; if (predicate(node)) return node;
  for (const child of node.children || []) { const match = find(child, predicate); if (match) return match; } return null; }
const button = (tree, label) => find(tree, n => n.type === 'button' && text(n) === label);
const fixture = () => ({ managementSession: { sessionId: null }, binding: { actorName: '测试伙伴' }, modelLogs: [],
  runtime: { state: 'stopped', running: false, model_calls: 2, replies: 1, posts: 0 } });

test('management conversation reminder links to the exact pending draft with no publish action', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.draft_notices = [{ id: 'draft-fixture', review_url: 'https://community.example/messages?draft=draft-fixture#post-drafts' }];
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const component = find(tree, n => typeof n.type === 'function' && n.type.name === 'DraftReviewReminder');
  assert.ok(component); const reminder = component.type(component.props);
  assert.match(text(reminder), /1份发帖草稿/); assert.match(text(reminder), /最终发表需在网站确认/);
  assert.equal(find(reminder, n => n.type === 'a').props.href, state.runtime.draft_notices[0].review_url);
  assert.equal(find(reminder, n => n.type === 'button'), null);
});

test('chat polling is read-only until the human selects this session; updates reuse one card', async () => {
  const ui = page(fixture()); ui.render(); let tree = await ui.settle();
  assert.ok(button(tree, '在此查看碳硅动态'));
  assert.ok(ui.requests.every(r => !r.options.method));
  await button(tree, '在此查看碳硅动态').props.onClick(); tree = await ui.settle();
  assert.match(text(tree), /本会话接收动态/);
  assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 1);
  await ui.poll(); await ui.poll();
  assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.ok(ui.requests.every(r => r.url === '/api/tangui/registration'));
  ui.dispose(); assert.equal(ui.timers.size, 0);
});

test('generation, queued submission and failures remain distinct; lost refresh recovers', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.modelLogs = [{ call_id: 'test-call', purpose: 'community_reply', phase: 'completed', elapsed_ms: 2000 }];
  state.runtime.last_model_call = { call_id: 'test-call', status: 'submitted' };
  state.runtime.last_submission = { call_id: 'test-call', status: 'queued' };
  const ui = page(state); ui.render(); let tree = await ui.settle();
  assert.match(text(tree), /模型生成完成.*已排队，尚未展示/); assert.doesNotMatch(text(tree), /已公开发表/);
  ui.fail(true); tree = await ui.poll(); assert.match(text(tree), /上次状态/); assert.doesNotMatch(text(tree), /private upstream/);
  state.modelLogs[0].phase = 'timed_out'; ui.setState(state); ui.fail(false); tree = await ui.poll();
  assert.match(text(tree), /需要处理/); assert.match(text(tree), /模型等待超时/); assert.doesNotMatch(text(tree), /上次状态/);
});

test('another chat can navigate without rebinding or triggering a prompt', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-original';
  const ui = page(state); ui.render(); const tree = await ui.settle();
  assert.doesNotMatch(text(tree), /累计模型调用/);
  await button(tree, '打开管理会话').props.onClick(); await ui.settle();
  assert.deepEqual(ui.opened, ['session-original']);
  assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 0);
});

test('old server does not allow a pretend binding', async () => {
  const state = fixture(); delete state.managementSession;
  const ui = page(state); ui.render(); const tree = await ui.settle();
  assert.equal(button(tree, '在此查看碳硅动态').props.disabled, true);
  assert.match(text(tree), /重启 DSH/);
});

test('hidden card stops UI polling and returns to the same binding when another tab enables it', async () => {
  const state = fixture(); state.managementSession = { sessionId: 'session-current' };
  const ui = page(state, 'session-current', false); assert.equal(ui.render(), null); assert.equal(await ui.settle(), null);
  assert.equal(ui.requests.length, 0); assert.equal(ui.timers.size, 0);
  ui.visibility(true); ui.render(); const tree = await ui.settle(); assert.match(text(tree), /本会话接收动态/);
  assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 0);
  ui.visibility(false); assert.equal(ui.render(), null); assert.equal(ui.timers.size, 0);
  ui.dispose(); assert.equal(ui.timers.size, 0);
});

test('chat card distinguishes temporary reconnection from stopped, online and permanent errors', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime = { ...state.runtime, state: 'reconnecting', detail: 'network_retry', running: true, stopping: false,
    reconnect: { attempt: 2, delay_seconds: 5 }, error: null };
  const ui = page(state); ui.render(); let tree = await ui.settle();
  let status = find(tree, node => node.props.className === 'tangui-status-orange' && /重连/.test(text(node)));
  assert.ok(status); assert.match(text(status), /连接中断/); assert.doesNotMatch(text(status), /停止|在线|正在观察/);
  assert.doesNotMatch(text(tree), /需要处理/);
  state.runtime = { ...state.runtime, state: 'observing', detail: 'waiting', reconnect: null }; ui.setState(state); tree = await ui.poll();
  assert.ok(find(tree, node => node.props.className === 'tangui-status-blue' && /正在观察社区/.test(text(node))));
  assert.ok(!find(tree, node => node.props.className === 'tangui-status-orange' && /重连/.test(text(node))));
  state.runtime = { ...state.runtime, state: 'reconnecting', stopping: true }; ui.setState(state); tree = await ui.poll();
  assert.ok(find(tree, node => node.props.className === 'tangui-status-gray' && /社区正在停止/.test(text(node))));
  ui.dispose();
});

const observation = (overrides = {}) => ({ last_check: { at: '2026-10-29T14:32:05+08:00', model_calls: 0, status: 'completed', reason: 'no_new_content' },
  last_trigger: null, waiting_video_events: 0, interrupted_model: null, ...overrides });
const observationBlock = (ui, tree) => {
  const node = find(tree, n => typeof n.type === 'function' && n.type.name === 'ObservationSummary');
  assert.ok(node, 'ObservationSummary is wired into this view');
  return ui.mount(node);
};

test('old server without observation still renders the card without extra status', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  const ui = page(state); ui.render(); const tree = await ui.settle();
  assert.match(text(tree), /本会话接收动态/);
  assert.equal(observationBlock(ui, tree), null);
  assert.doesNotMatch(text(tree), /最近检查|最近社区调用|等待视频材料|未保存完整结果/);
});

test('an empty observation round names no community calls without claiming zero cost', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation();
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /最近检查/);
  assert.match(text(block), /本轮没有新内容/);
  assert.match(text(block), /本轮未发起社区\/日记\/起草模型调用/);
  assert.match(text(block), /仅统计社区、日记与起草，不含游戏和 DSH 对话/);
  assert.doesNotMatch(text(block), /模型调用 0 次/);
  assert.doesNotMatch(text(block), /账单为零|零费用|没有任何费用/);
});

test('a non-zero observation round shows the call count within the community scope', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation({ last_check: { at: '2026-10-29T14:35:00+08:00', model_calls: 3, status: 'completed', reason: 'checked' } });
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /本轮社区\/日记\/起草模型调用 3 次/);
  assert.match(text(block), /已检查新内容/);
});

test('a missing observation count is unknown rather than a zero-call claim', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation({ last_check: { at: '2026-10-29T14:35:00+08:00', status: 'completed', reason: 'checked' } });
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /调用次数未知/); assert.doesNotMatch(text(block), /未发起|调用 0 次/);
  ui.dispose();
});

test('each trigger kind renders as plain Chinese without exposing identifiers', async () => {
  const kinds = { browse: '阅读新帖', human_mention: '收到人类的 @', ai_mention: '收到 AI 的 @', reply: '收到回复', diary_summary: '整理日记', post_draft: '构思帖子' };
  for (const [kind, label] of Object.entries(kinds)) {
    const state = fixture(); state.managementSession.sessionId = 'session-current';
    state.runtime.observation = observation({ last_trigger: { kind, at: '2026-10-29T14:36:00+08:00', post_id: 'post-secret-42', call_number: 7 } });
    const ui = page(state); ui.render(); const tree = await ui.settle();
    const block = observationBlock(ui, tree);
    assert.ok(text(block).includes(label), kind);
    assert.match(text(block), /第 7 次/);
    assert.doesNotMatch(text(block), /post-secret-42/);
    assert.doesNotMatch(text(tree), /post-secret-42/);
    ui.dispose();
  }
});

test('unknown trigger kinds and extra fields stay hidden', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation({ last_trigger: { kind: 'telemetry_probe', at: '2026-10-29T14:36:00+08:00', post_id: 'post-secret-42', hint: 'secret-hint-99', raw_payload: 'raw-abc' } });
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.doesNotMatch(text(block), /telemetry_probe|secret-hint-99|raw-abc|post-secret-42/);
});

test('waiting content explains the queue while other messages keep flowing', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation({ waiting_events: 2, last_check: { at: '2026-10-29T14:37:00+08:00', model_calls: 0, status: 'completed', reason: 'waiting_content' } });
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /有 2 条互动消息等待继续处理/);
  assert.match(text(block), /其他消息仍可继续处理/);
});

test('interrupted model call is flagged with no approval or auto action', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime.observation = observation({ interrupted_model: { at: '2026-10-29T14:38:00+08:00', kind: 'reply', post_id: 'post-hidden-9' } });
  const ui = page(state); ui.render(); const tree = await ui.settle();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /上次模型调用（收到回复）未保存完整结果/);
  assert.match(text(block), /费用是否发生无法确定/);
  assert.match(text(block), /再次启动可能重新调用/);
  assert.doesNotMatch(text(block), /post-hidden-9/);
  assert.equal(find(block, n => n.type === 'button'), null);
  assert.equal(find(tree, n => n.type === 'button'), null);
});

test('observation survives the loop detail resetting to waiting and polling stays read-only', async () => {
  const state = fixture(); state.managementSession.sessionId = 'session-current';
  state.runtime = { ...state.runtime, state: 'observing', detail: 'waiting', running: true };
  state.runtime.observation = observation({ last_trigger: { kind: 'ai_mention', at: '2026-10-29T14:39:00+08:00', post_id: 'post-x', call_number: 11 } });
  const ui = page(state); ui.render(); let tree = await ui.settle();
  assert.match(text(tree), /正在观察社区/);
  assert.match(text(observationBlock(ui, tree)), /收到 AI 的 @/);
  state.runtime.observation = observation({ last_check: { at: '2026-10-29T14:40:00+08:00', model_calls: 1, status: 'completed', reason: 'checked' },
    last_trigger: { kind: 'reply', at: '2026-10-29T14:39:30+08:00', post_id: 'post-y', call_number: 12 } });
  ui.setState(state); tree = await ui.poll();
  const block = observationBlock(ui, tree);
  assert.match(text(block), /本轮社区\/日记\/起草模型调用 1 次/);
  assert.match(text(block), /收到回复/);
  assert.doesNotMatch(text(block), /post-x|post-y/);
  assert.ok(ui.requests.every(r => !r.options.method));
  ui.dispose();
});

test('RuntimePanel reuses the same read-only observation summary', async () => {
  const state = { platformUrl: 'https://community.example', memoryDir: 'M', draft: { name: '', description: '', overrides: {} },
    binding: { actorName: '测试伙伴' }, managementSession: { sessionId: 'session-current' }, modelLogs: [],
    runtime: { state: 'observing', detail: 'waiting', running: true, model_calls: 2, replies: 1, posts: 0,
      observation: observation({ last_trigger: { kind: 'human_mention', at: '2026-10-29T14:41:00+08:00', post_id: 'post-z', call_number: 13 } }) },
    runtimeConnection: {} };
  const ui = page(state, 'session-current', true, 'settings.section'); ui.render(); const tree = await ui.settle();
  const panel = find(tree, n => typeof n.type === 'function' && n.type.name === 'RuntimePanel');
  assert.ok(panel, 'RuntimePanel is part of the settings section');
  const panelTree = ui.mount(panel);
  const block = observationBlock(ui, panelTree);
  assert.match(text(block), /最近检查/);
  assert.match(text(block), /收到人类的 @/);
  assert.match(text(block), /仅统计社区、日记与起草/);
  assert.doesNotMatch(text(block), /post-z/);
  assert.ok(ui.requests.every(r => !r.options.method));
  ui.dispose();
});
