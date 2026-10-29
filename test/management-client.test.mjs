import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual chat-slot component, including its network and navigation
// boundaries. No real session, model, community or credential is used.
function page(initial, sessionId = 'session-current', visible = true) {
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
    window: { __ModuleLoader__: { load(v) { factory = v.factory; } },
      addEventListener(name, callback) { if (name === 'storage') storageListeners.add(callback); },
      removeEventListener(name, callback) { if (name === 'storage') storageListeners.delete(callback); } }, AbortController,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
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
  const Component = components.get('conversation.input.dock');
  assert.ok(Component);
  const owner = { hooks: [], index: 0, effects: [] };
  const render = () => { current = owner; owner.index = 0; owner.effects = []; const tree = Component({ sessionId }); owner.effects.forEach(f => f()); return tree; };
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); return render(); };
  return { render, settle, requests, opened, setState(value) { state = value; }, fail(value) { failed = value; },
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
