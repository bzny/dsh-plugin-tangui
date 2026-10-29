import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Run the real unbundled settings component with a small hook host. No DSH
// session, model, community, browser storage or network is used by this test.
function page(storage, state) {
  let factory, Section, current;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const owner = current, i = owner.index++;
      if (!owner.hooks[i]) owner.hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [owner.hooks[i].value, value => { owner.hooks[i].value = typeof value === 'function' ? value(owner.hooks[i].value) : value; }];
    },
    useRef(initial) {
      const owner = current, i = owner.index++;
      return (owner.hooks[i] ||= { current: initial });
    },
    useEffect(effect, deps) {
      const owner = current, i = owner.index++, previous = owner.hooks[i];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        owner.effects.push(() => { previous?.cleanup?.(); owner.hooks[i] = { deps, cleanup: effect() }; });
      }
    },
  };
  const context = { window: { __ModuleLoader__: { load(value) { factory = value.factory; } } },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, setInterval: () => 1, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => structuredClone(state) }),
  };
  vm.runInNewContext(readFileSync('client.js', 'utf8'), context);
  const plugin = factory(name => { assert.equal(name, 'react'); return React; });
  plugin.apply({ slots: { inject(_name, callback) { callback(); }, register(_config, component) { Section = component; } } });
  function mount(Component, props = {}) {
    const owner = { hooks: [], index: 0, effects: [] };
    return { render() { current = owner; owner.index = 0; owner.effects = []; const result = Component(props); owner.effects.forEach(effect => effect()); return result; } };
  }
  return { section: mount(Section), mount };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const fixture = () => ({ platformUrl: 'https://community.example', memoryDir: 'C:/fixture-memory', enabled: false, status: 'disabled',
  sourceComplete: true, draft: { name: '伙伴', description: '原始人设', overrides: {} }, memoryDiscovery: { status: 'unknown' },
  normalization: { status: 'unprepared' }, capabilities: { connectionSwitch: true }, binding: { actorId: 'ai-fixture' },
  updates: { current: '0.4.1', auto: true, mode: 'managed', state: 'current' },
  runtime: { state: 'stopped', detail: 'not_started', model_calls: 0, replies: 0, posts: 0 },
  runtimeConnection: { binding: { scopes: ['posts:write'] } } });
async function renderSection(ui) { ui.section.render(); for (let i = 0; i < 6; i++) await Promise.resolve(); return ui.section.render(); }

test('unsaved persona survives component replacement and fields lock during installation', async () => {
  const storage = new Map(), state = fixture();
  const first = page(storage, state); let tree = await renderSection(first);
  let field = find(tree, node => node.type === 'textarea' && node.props.value === '原始人设'); assert.ok(field);
  field.props.onChange({ target: { value: '尚未保存的人设修改' } }); first.section.render();
  assert.ok([...storage.values()].some(value => value.includes('尚未保存的人设修改')));
  state.updates.state = 'installing';
  tree = await renderSection(page(storage, state));
  field = find(tree, node => node.type === 'textarea' && node.props.value === '尚未保存的人设修改');
  assert.ok(field); assert.equal(field.props.disabled, true);
  const other = fixture(); other.binding.actorId = 'another-ai';
  tree = await renderSection(page(storage, other));
  assert.ok(find(tree, node => node.type === 'textarea' && node.props.value === '原始人设'));
});

test('post draft survives component replacement and can be explicitly cleared', async () => {
  const storage = new Map(), state = fixture();
  const first = page(storage, state); let section = await renderSection(first);
  let runtime = find(section, node => typeof node.type === 'function' && node.type.name === 'RuntimePanel');
  const panel = first.mount(runtime.type, runtime.props); let tree = panel.render();
  let title = find(tree, node => node.type === 'label' && String(node.children[0]).startsWith('标题（'));
  title.children.find(node => node?.type === 'input').props.onChange({ target: { value: '尚未发表的帖子' } }); panel.render();
  const second = page(storage, state); section = await renderSection(second);
  runtime = find(section, node => typeof node.type === 'function' && node.type.name === 'RuntimePanel');
  const restored = second.mount(runtime.type, runtime.props); tree = restored.render();
  assert.ok(find(tree, node => node.type === 'input' && node.props.value === '尚未发表的帖子'));
  const clear = find(tree, node => node.type === 'button' && node.children[0] === '清空草稿'); clear.props.onClick(); restored.render();
  assert.equal([...storage.keys()].filter(key => key.startsWith('tangui-draft-v1:post:')).length, 0);
});

test('settings card switch remembers this browser preference while AI is running', async () => {
  const storage = new Map(), state = fixture(); state.runtime.running = true;
  const ui = page(storage, state); let tree = await renderSection(ui);
  let toggle = find(tree, node => node.props.role === 'switch');
  assert.ok(toggle); assert.equal(toggle.props.checked, true); assert.ok(!toggle.props.disabled);
  toggle.props.onChange({ target: { checked: false } }); tree = ui.section.render();
  assert.equal(find(tree, node => node.props.role === 'switch').props.checked, false);
  assert.equal(storage.get('tangui-management-card-visible'), 'off'); assert.equal(state.runtime.running, true);
  tree = await renderSection(page(storage, state)); toggle = find(tree, node => node.props.role === 'switch');
  assert.equal(toggle.props.checked, false);
  toggle.props.onChange({ target: { checked: true } }); assert.equal(storage.get('tangui-management-card-visible'), 'on');
});

const updateCandidate = { version: '0.4.5', commit: 'a'.repeat(40), tag: 'v0.4.5',
  url: 'https://github.com/bzny/dsh-plugin-tangui/releases/tag/v0.4.5' };
async function renderUpdatePanel(overrides = {}, busy = false) {
  const state = fixture();
  state.updates = { ...state.updates, current: '0.4.4', latest: '0.4.5', state: 'available',
    manualInstall: true, canInstall: true, candidate: updateCandidate, ...overrides };
  const ui = page(new Map(), state), section = await renderSection(ui);
  const component = find(section, node => typeof node.type === 'function' && node.type.name === 'UpdatePanel');
  assert.ok(component);
  const calls = [];
  const tree = ui.mount(component.type, { ...component.props, update: state.updates,
    action: value => calls.push(JSON.parse(JSON.stringify(value))), busy }).render();
  return { tree, calls, state };
}
function immediateUpdate(tree) {
  return find(tree, node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.includes('立即更新')));
}
function visibleText(node) {
  if (typeof node === 'string') return node;
  return (node?.children || []).map(visibleText).join(' ');
}

test('manual update submits the displayed immutable candidate even with automatic updates off', async () => {
  const { tree, calls, state } = await renderUpdatePanel({ auto: false, reason: 'auto_disabled' });
  const button = immediateUpdate(tree);
  assert.ok(button); assert.ok(!button.props.disabled);
  assert.ok(visibleText(button).includes('v0.4.5'));
  button.props.onClick();
  assert.deepEqual(calls, [{ action: 'update_install', version: '0.4.5', commit: 'a'.repeat(40) }]);
  assert.equal(state.updates.auto, false);
  assert.match(visibleText(tree), /自动更新已关闭，可点击立即更新完成本次安装/);
  assert.ok(find(tree, node => node.type === 'button' && node.children.includes('检查更新')));
});

test('checking, installing, pending restart and busy UI cannot launch another installation', async t => {
  for (const state of ['checking', 'installing', 'restarting_needed']) {
    await t.test(state, async () => {
      const { tree, calls } = await renderUpdatePanel({ state, canInstall: false });
      const button = immediateUpdate(tree); assert.ok(!button || button.props.disabled);
      button?.props.onClick(); assert.equal(calls.length, 0);
      assert.doesNotMatch(visibleText(tree), /来源、宿主或候选尚不可安装/);
    });
  }
  const { tree } = await renderUpdatePanel({}, true);
  const button = immediateUpdate(tree); assert.ok(!button || button.props.disabled);
});

test('development, unsupported hosts and dependency changes stay check-only', async t => {
  for (const options of [
    { mode: 'development', installation: 'development-source', reason: 'development_check_only', canInstall: false },
    { mode: 'managed', reason: 'host_check_only', canInstall: false },
    { state: 'error', error: 'manual_required_dependencies', candidate: null, canInstall: false },
  ]) {
    await t.test(options.reason || options.error, async () => {
      const { tree } = await renderUpdatePanel(options);
      const button = immediateUpdate(tree); assert.ok(!button || button.props.disabled);
      assert.match(visibleText(tree), /手动|开发源码/);
    });
  }
});

test('older service and missing candidates never offer an enabled new action', async () => {
  const old = await renderUpdatePanel({ manualInstall: undefined });
  const oldButton = immediateUpdate(old.tree); assert.ok(!oldButton || oldButton.props.disabled);
  oldButton?.props.onClick(); assert.equal(old.calls.length, 0);
  assert.match(visibleText(old.tree), /尚未|旧版/);
  for (const candidate of [null, { version: '0.4.5' }, { commit: 'a'.repeat(40) }]) {
    const { tree } = await renderUpdatePanel({ candidate });
    const button = immediateUpdate(tree); assert.ok(!button || button.props.disabled);
  }
});

test('busy installation tells manual and automatic users the correct next step', async () => {
  const manual = await renderUpdatePanel({ state: 'waiting_idle', reason: 'runtime_busy', auto: false });
  assert.match(visibleText(manual.tree), /再.*点击|再次.*更新/);
  const automatic = await renderUpdatePanel({ state: 'waiting_idle', reason: 'runtime_busy', auto: true });
  assert.match(visibleText(automatic.tree), /自动更新|自动安装/);
});

async function renderRuntime(overrides = {}) {
  const state = fixture(); state.runtime = { ...state.runtime, state: 'reconnecting', detail: 'network_retry', running: true,
    stopping: false, error: null, reconnect: { attempt: 2, delay_seconds: 5 }, ...overrides };
  const ui = page(new Map(), state), section = await renderSection(ui);
  const component = find(section, node => typeof node.type === 'function' && node.type.name === 'RuntimePanel'); assert.ok(component);
  const calls = [];
  const tree = ui.mount(component.type, { ...component.props, state, busy: false, action: value => calls.push(JSON.parse(JSON.stringify(value))) }).render();
  return { tree, calls };
}

test('temporary reconnection is orange, keeps stop enabled and prevents duplicate starts', async () => {
  const { tree, calls } = await renderRuntime();
  const status = find(tree, node => String(node.props.className || '').includes('tangui-status-orange') && /重连/.test(visibleText(node)));
  assert.ok(status); assert.match(visibleText(status), /连接中断/);
  assert.ok(String(tree.props.className || '').includes('tangui-session-status'), 'status color variables are defined on the runtime panel');
  assert.doesNotMatch(visibleText(status), /已获得控制权|正在观察|已停止|在线/);
  assert.match(visibleText(tree), /2.*重试|重试.*2/); assert.match(visibleText(tree), /5.*秒/);
  const stop = find(tree, node => node.type === 'button' && node.children.includes('停止运行')); assert.ok(stop); assert.equal(stop.props.disabled, false);
  stop.props.onClick(); assert.deepEqual(calls, [{ action: 'runtime_stop' }]);
  for (const label of ['浏览一次', '持续观察']) assert.equal(find(tree, node => node.type === 'button' && node.children.includes(label)).props.disabled, true);
});

test('stopping remains a user-stop state rather than an active retry', async () => {
  const { tree } = await renderRuntime({ stopping: true });
  const stop = find(tree, node => node.type === 'button' && node.children.includes('正在停止…')); assert.ok(stop); assert.equal(stop.props.disabled, true);
  assert.ok(!find(tree, node => String(node.props.className || '').includes('tangui-status-orange') && /重连/.test(visibleText(node))));
  assert.doesNotMatch(visibleText(tree), /network_retry|reconnecting/);
});

test('invalid optional retry metadata does not fabricate a retry count or countdown', async () => {
  const { tree } = await renderRuntime({ reconnect: { attempt: -1, delay_seconds: NaN } });
  assert.match(visibleText(tree), /重连/); assert.doesNotMatch(visibleText(tree), /NaN|undefined|第 -1|等待 -1/);
});

test('hourly update schedule explains Beijing quiet hours without disabling manual checks', async () => {
  const { tree, calls } = await renderUpdatePanel({ state: 'current', candidate: null, canInstall: false });
  assert.match(visibleText(tree), /每小时|每 1 小时/);
  assert.match(visibleText(tree), /北京时间.*01:00.*07:00.*暂停自动检查/);
  assert.match(visibleText(tree), /随时.*手动检查|手动检查.*随时/);
  assert.doesNotMatch(visibleText(tree), /每 6 小时/);
  const check = find(tree, node => node.type === 'button' && node.children.includes('检查更新')); assert.ok(check); assert.equal(check.props.disabled, false);
  check.props.onClick(); assert.deepEqual(calls, [{ action: 'update_check' }]);
});
