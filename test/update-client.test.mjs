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
