import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const propsFor = (actorId = 'ai-a', actorName = '伙伴甲') => ({actorId, actorName, baseUrl: 'https://community.example/'});
const row = (id, reflection, extra = {}) => ({id, occurred_at: '2026-10-30T01:02:03Z', local_date: '2026-10-30', local_time: '09:02:03', kind: 'post_read', kind_label: '读帖有感', reflection, resource: {title: '公开帖子'}, ...extra});
const result = (body, extra = {}) => ({
  identity: {base_url: body.expected_base_url, actor_id: body.expected_actor_id}, timezone: 'Asia/Shanghai', display_timezone: 'Asia/Shanghai', timezone_known: true,
  order: body.date ? 'asc' : 'desc', date: body.date || null,
  items: [row(body.cursor ? 'older' : 'latest', body.cursor ? '较早的感想' : '刚留下的感想')],
  dates: [{date: '2026-10-30', count: 2}, {date: '2026-10-29', count: 1}], next_cursor: body.date || body.cursor ? null : 'opaque-next', has_more: !body.date && !body.cursor, total: 3,
  notice: '这些记录仅在本机保存。', ...extra,
});
const response = (thoughts, status = 200, code = '') => ({ok: status >= 200 && status < 300, status, json: async () => status >= 400 ? {error: {code, message: 'private error detail never show'}} : {thoughts}});
const textOf = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : (node.children || []).map(textOf).join('');
function all(node, predicate, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(child => all(child, predicate, out)); return out; }
  if (predicate(node)) out.push(node); (node.children || []).forEach(child => all(child, predicate, out)); return out;
}

// The component is captured only inside this isolated VM; no test hook or
// global is added to the shipped plugin.
function harness(intercept, initialProps = propsFor()) {
  let definition, Component, props = initialProps, cursor = 0, dirty = true, tree, pending = [], focusCount = 0;
  const hooks = [], calls = [];
  const React = {
    createElement: (type, properties, ...children) => ({type, props: properties || {}, children: children.flat(Infinity)}),
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [hooks[index].value, next => { const value = typeof next === 'function' ? next(hooks[index].value) : next; if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; if (!hooks[index]) hooks[index] = {current: initial}; return hooks[index]; },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => { previous?.cleanup?.(); hooks[index] = {deps, cleanup: effect()}; });
    },
  };
  const injection = "    return { inject: ['slots']";
  assert.equal(source.split(injection).length, 2);
  vm.runInNewContext(source.replace(injection, '    __capture(PartnerThoughts);\n' + injection), {
    URL, AbortController, console,
    window: {__ModuleLoader__: {load(value) { definition = value; }}},
    __capture: value => { Component = value; },
    fetch: async (url, options) => {
      const call = {url, ...options, body: JSON.parse(options.body)}; calls.push(call);
      const overridden = await intercept?.(call);
      return overridden === undefined ? response(result(call.body)) : overridden;
    },
  });
  definition.factory(() => React);
  const render = () => {
    dirty = false; cursor = 0; pending = []; tree = Component(props);
    for (const item of all(tree, node => node.props?.ref)) item.props.ref.current = {focus() { focusCount++; }};
    pending.forEach(effect => effect()); return tree;
  };
  const flush = async () => {
    for (let i = 0; i < 12; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); }
    if (dirty) render();
    return tree;
  };
  return {
    calls, flush, render, text: () => textOf(tree), nodes: predicate => all(tree, predicate), focusCount: () => focusCount,
    button(label) { return all(tree, node => node.type === 'button' && textOf(node).includes(label))[0]; },
    async click(label) { const button = this.button(label); assert.ok(button, `Missing ${label}`); assert.equal(button.props.disabled, undefined, 'Use explicit disabled assertion when needed'); button.props.onClick(); await flush(); },
    async press(label) { const button = this.button(label); assert.ok(button, `Missing ${label}`); assert.ok(!button.props.disabled, `Disabled ${label}`); button.props.onClick(); await flush(); },
    async select(date) { const select = all(tree, node => node.type === 'select')[0]; assert.ok(select); select.props.onChange({target: {value: date}}); await flush(); },
    setProps(value) { props = value; dirty = true; return render(); },
    dispose() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

test('only explicit opening reads local authored thoughts; text is escaped and no model/log action runs', async () => {
  const htmlText = '<img src=x onerror=alert(1)> 这是成文感想';
  const t = harness(call => response(result(call.body, {items: [row('unsafe-markup', htmlText)]}))); await t.flush();
  assert.equal(t.calls.length, 0); assert.ok(t.button('查看伙伴想法'));
  await t.press('查看伙伴想法');
  assert.equal(t.calls.length, 1); assert.deepEqual(t.calls[0].body, {action: 'thoughts', limit: 20, expected_actor_id: 'ai-a', expected_base_url: 'https://community.example'});
  assert.equal(t.calls[0].url, '/api/tangui/registration'); assert.equal(t.calls[0].headers['x-tangui-client'], '1');
  assert.equal(t.calls[0].credentials, 'same-origin'); assert.equal(t.calls[0].cache, 'no-store');
  assert.match(t.text(), /Asia\/Shanghai/); assert.match(t.text(), /读帖有感/); assert.ok(t.text().includes(htmlText));
  assert.equal(t.nodes(node => node.type === 'img' || node.props.dangerouslySetInnerHTML).length, 0);
  await t.press('关闭'); assert.equal(t.focusCount(), 1); assert.equal(t.calls.length, 1); assert.ok(!t.text().includes(htmlText));
});

test('cursor paging is opaque and date mode clears old records then asks for that day in ascending order', async () => {
  const t = harness(call => call.body.date ? response(result(call.body, {items: [row('morning', '当天早上的感想'), row('night', '当天晚上的回想')], has_more: false, next_cursor: null})) : undefined); await t.flush();
  await t.press('查看伙伴想法'); await t.press('下一页');
  assert.equal(t.calls.at(-1).body.cursor, 'opaque-next'); assert.match(t.text(), /较早的感想/); assert.doesNotMatch(t.text(), /刚留下的感想/);
  await t.press('上一页'); assert.equal(t.calls.at(-1).body.cursor, undefined); assert.match(t.text(), /刚留下的感想/);
  await t.press('按日回看'); assert.doesNotMatch(t.text(), /刚留下的感想/); assert.match(t.text(), /请选择/);
  await t.select('2026-10-29'); assert.equal(t.calls.at(-1).body.date, '2026-10-29'); assert.equal(t.calls.at(-1).body.cursor, undefined);
  assert.match(t.text(), /从早到晚/); assert.ok(t.text().indexOf('当天早上的感想') < t.text().indexOf('当天晚上的回想'));
  await t.press('最新在前'); assert.equal(t.calls.at(-1).body.date, undefined); assert.equal(t.calls.at(-1).body.cursor, undefined);
});

test('unknown diary timezone keeps UTC reading available but disables daily selection', async () => {
  const t = harness(call => response(result(call.body, {timezone: null, display_timezone: 'UTC', timezone_known: false, dates: [], notice: '伙伴日记时区尚未同步，时间先按UTC显示。'}))); await t.flush(); await t.press('查看伙伴想法');
  assert.match(t.text(), /UTC/); assert.match(t.text(), /刚留下的感想/); assert.equal(t.button('按日回看').props.disabled, true);
  assert.ok(!t.button('刷新').props.disabled);
});

test('closing aborts a read and ignores its late result', async () => {
  let finish;
  const t = harness(call => new Promise(resolve => { finish = () => resolve(response(result(call.body, {items: [row('late', '迟到内容不能显示')]}))); })); await t.flush();
  const opening = t.press('查看伙伴想法'); await t.flush(); await opening;
  assert.equal(t.calls.length, 1); await t.press('关闭'); assert.equal(t.calls[0].signal.aborted, true);
  finish(); await t.flush(); assert.doesNotMatch(t.text(), /迟到内容/); assert.ok(t.button('查看伙伴想法'));
});

test('identity change hides old content on the first render and rejects an old in-flight response', async () => {
  let finishOld;
  const t = harness(call => call.body.expected_actor_id === 'ai-a' ? new Promise(resolve => { finishOld = () => resolve(response(result(call.body, {items: [row('old', '甲的私人记录')]}))); }) : response(result(call.body, {items: [row('new', '乙的私人记录')]})));
  await t.flush(); await t.press('查看伙伴想法');
  const switchedTree = t.setProps(propsFor('ai-b', '伙伴乙'));
  assert.doesNotMatch(textOf(switchedTree), /甲的私人记录|正在读取想法/); await t.flush();
  assert.equal(t.calls[0].signal.aborted, true); finishOld(); await t.flush(); assert.doesNotMatch(t.text(), /甲的私人记录/);
  await t.press('查看伙伴想法'); assert.match(t.text(), /乙的私人记录/); assert.doesNotMatch(t.text(), /甲的私人记录/);
  assert.equal(t.calls.at(-1).body.expected_actor_id, 'ai-b');
});

test('a returned wrong identity clears the reader and never displays the other actor text', async () => {
  const t = harness(call => response(result(call.body, {identity: {base_url: 'https://community.example', actor_id: 'someone-else'}, items: [row('private', '他人的私人记录')]}))); await t.flush(); await t.press('查看伙伴想法');
  assert.match(t.text(), /伙伴身份已变化/); assert.doesNotMatch(t.text(), /他人的私人记录/); assert.ok(t.button('查看伙伴想法'));
});

test('old or malformed API replies are errors rather than an empty successful page', async () => {
  const old = harness(() => response(null, 404, 'not_found')); await old.flush(); await old.press('查看伙伴想法');
  assert.match(old.text(), /尚未加载想法阅读功能/); assert.doesNotMatch(old.text(), /private error detail/); assert.ok(old.button('重试'));
  const malformed = harness(call => response(result(call.body, {order: 'asc'}))); await malformed.flush(); await malformed.press('查看伙伴想法');
  assert.match(malformed.text(), /返回内容不完整/); assert.doesNotMatch(malformed.text(), /还没有主动留下/);
});

test('an explicitly empty page has an honest empty state', async () => {
  const t = harness(call => response(result(call.body, {items: [], total: 0, next_cursor: null, has_more: false, dates: []}))); await t.flush(); await t.press('查看伙伴想法');
  assert.match(t.text(), /还没有主动留下的想法/); assert.match(t.text(), /共 0 条/); assert.equal(t.button('下一页').props.disabled, true);
});
