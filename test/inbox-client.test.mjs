import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Render the real client.js components with a minimal React implementation.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function createHarness() {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof init === 'function' ? init() : init;
      const set = (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; };
      return [hooks[index], set];
    },
    useRef: (init) => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: init };
      return hooks[index];
    },
    useEffect: (fn) => { effects.push(fn); },
  };
  const renderNode = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }));
    return { ...node, children: (node.children || []).map(renderNode) };
  };
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return (node.children || []).map(textOf).join('');
  };
  const findAll = (node, pred, out = []) => {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return out;
    if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out; }
    if (node.type && pred(node)) out.push(node);
    for (const child of node.children || []) findAll(child, pred, out);
    return out;
  };
  return {
    React, findAll, textOf,
    render(rootElement) {
      cursor = 0;
      effects = [];
      const tree = renderNode(rootElement);
      const pending = effects;
      return { tree, text: textOf(tree), runEffects: () => pending.forEach(fn => fn()) };
    },
  };
}

function loadPlugin(React, fetchMock) {
  const loaded = [];
  const context = {
    window: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: () => ({ style: {}, click() {} }) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    URL, console, crypto: { randomUUID },
    AbortController,
    fetch: fetchMock,
  };
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.document = context.document;
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.__ModuleLoader__ = { load(definition) { loaded.push(definition); } };
  context.window.__ModuleLoader__ = context.__ModuleLoader__;
  vm.runInNewContext(source, context);
  const plugin = loaded[0].factory(() => React);
  const registered = {};
  plugin.apply({
    get: () => undefined,
    slots: {
      inject(_name, callback) { callback(); },
      register(definition, component) { registered[definition.id] = { definition, component }; },
    },
  });
  return registered;
}

const inboxFixture = (extra = {}) => ({
  actor_id: 'ai-x', checked_at: '2026-10-29T08:00:00Z', error: null,
  unread_count: 4, friend_request_count: 2, dm_request_count: 1, unread_dm_count: 3,
  friend_requests: [{ id: 'r1', actor: { id: 'h1', name: '阿碳', kind: 'human' } }, { id: 'r2', actor: { id: 'a1', name: '硅硅', kind: 'ai' } }],
  dm_requests: [{ id: 'd1', actor: { id: 'h2', name: '路人甲', kind: 'human' } }],
  messages_url: 'https://community.example/messages?actor_id=ai-x#private',
  friends_url: 'https://community.example/?social=friends&actor_id=ai-x',
  ...extra,
});

function registrationState(inbox, extraRuntime = {}) {
  return {
    platformUrl: 'https://community.example',
    memoryDir: '', enabled: true, status: 'bound', sourceReason: 'fixture',
    binding: { actorId: 'ai-x', actorName: '小硅' },
    managementSession: { sessionId: 'sess-1' },
    draft: { name: '小硅', description: 'd', overrides: {} },
    sourceComplete: true, sourceDescription: 'd', defaultModel: 'fixture-model',
    normalization: { status: 'ready', changed: false },
    capabilities: { connectionSwitch: true },
    updates: null, modelLogs: [], modelOutputLimit: 64000,
    runtime: {
      running: false, state: 'stopped', model_calls: 0, replies: 0, posts: 0,
      preferences: { community: { configured: true } },
      diary: { entry_count: 0, directory: '', diaries: [] },
      observation: null, inbox, ...extraRuntime,
    },
    runtimeConnection: { binding: true },
  };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function mountCard(harness, Card, sessionId) {
  const root = { type: Card, props: { sessionId }, children: [] };
  let current = null;
  const doRender = () => { const pass = harness.render(root); current = pass.tree; return pass; };
  return {
    text: () => harness.textOf(current),
    find: pred => harness.findAll(current, pred),
    async ready() {
      let pass = doRender();
      pass.runEffects();
      await flush();
      doRender();
      await flush();
      doRender();
    },
    async tick() { await flush(); doRender(); await flush(); },
  };
}

test('management card shows inbox counts, requesters, same-origin links and refreshes via action', async () => {
  const harness = createHarness();
  const posts = [];
  const inbox = inboxFixture({ body: '私信正文绝不展示' });
  const registered = loadPlugin(harness.React, async (_url, options = {}) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => registrationState(inbox) }; }
    return { ok: true, status: 200, json: async () => registrationState(inbox) };
  });
  const mounted = mountCard(harness, registered['tangui-activity'].component, 'sess-1');
  await mounted.ready();
  const text = mounted.text();
  assert.match(text, /收件提醒：/);
  assert.match(text, /好友申请 2/);
  assert.match(text, /私信请求 1/);
  assert.match(text, /未读私信 3/);
  assert.match(text, /阿碳、硅硅 等 2 人请求加为好友/);
  assert.match(text, /路人甲 等 1 人发来私信请求/);
  assert.doesNotMatch(text, /私信正文绝不展示/);
  assert.match(text, /上次检查/);
  const hrefs = mounted.find(node => node.type === 'a').map(node => node.props.href);
  assert.ok(hrefs.includes('https://community.example/messages?actor_id=ai-x#private'));
  assert.ok(hrefs.includes('https://community.example/?social=friends&actor_id=ai-x'));
  const refresh = mounted.find(node => node.type === 'button' && /刷新收件提醒/.test(harness.textOf(node))).at(-1);
  assert.ok(refresh);
  refresh.props.onClick();
  await mounted.tick();
  assert.deepEqual(posts.at(-1), { action: 'inbox_refresh' });
});

test('cross-origin inbox links are never rendered and empty inbox stays silent', async () => {
  const harness = createHarness();
  const evil = inboxFixture({ messages_url: 'https://evil.example/messages', friends_url: 'javascript:alert(1)' });
  const registered = loadPlugin(harness.React, async () => ({ ok: true, status: 200, json: async () => registrationState(evil) }));
  const mounted = mountCard(harness, registered['tangui-activity'].component, 'sess-1');
  await mounted.ready();
  assert.match(mounted.text(), /收件提醒：/);
  const hrefs = mounted.find(node => node.type === 'a').map(node => String(node.props.href));
  assert.ok(hrefs.every(href => href.startsWith('https://community.example/')), 'only same-origin links survive');
  const emptyState = registrationState({ actor_id: 'ai-x', checked_at: null, error: null, unread_count: 0, friend_request_count: 0, dm_request_count: 0, unread_dm_count: 0, friend_requests: [], dm_requests: [], messages_url: '', friends_url: '' });
  const harness2 = createHarness();
  const registeredAgain = loadPlugin(harness2.React, async () => ({ ok: true, status: 200, json: async () => emptyState }));
  const empty = mountCard(harness2, registeredAgain['tangui-activity'].component, 'sess-1');
  await empty.ready();
  assert.doesNotMatch(empty.text(), /收件提醒|无申请|好友申请/);
});

test('inbox failure keeps the last checked time visible', async () => {
  const harness = createHarness();
  const failed = inboxFixture({ error: 'network down' });
  const registered = loadPlugin(harness.React, async () => ({ ok: true, status: 200, json: async () => registrationState(failed) }));
  const mounted = mountCard(harness, registered['tangui-activity'].component, 'sess-1');
  await mounted.ready();
  assert.match(mounted.text(), /暂时无法刷新收件提醒/);
  assert.match(mounted.text(), /上次结果/);
});

test('runtime panel renders the inbox reminder and refreshes through the action prop even when stopped', async () => {
  const harness = createHarness();
  const posts = [];
  const inbox = inboxFixture();
  const registered = loadPlugin(harness.React, async (_url, options = {}) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => registrationState(inbox) }; }
    return { ok: true, status: 200, json: async () => registrationState(inbox) };
  });
  const section = registered['tangui-registration'].component;
  const root = { type: section, props: {}, children: [] };
  let current = null;
  let pass = harness.render(root);
  current = pass.tree;
  pass.runEffects();
  await flush();
  pass = harness.render(root);
  current = pass.tree;
  assert.match(pass.text, /社区运行/);
  assert.match(pass.text, /已停止/);
  assert.match(pass.text, /收件提醒：/);
  assert.match(pass.text, /阿碳、硅硅 等 2 人/);
  const refresh = harness.findAll(current, node => node.type === 'button' && /刷新收件提醒/.test(harness.textOf(node))).at(-1);
  assert.ok(refresh, 'runtime panel has its own refresh button');
  refresh.props.onClick();
  await flush();
  assert.deepEqual(posts.at(-1), { action: 'inbox_refresh' });
  // 0.5.3 更新面板与 ObservationSummary 结构保留
  assert.ok(harness.findAll(current, node => node.type === 'details').length >= 1);
});
