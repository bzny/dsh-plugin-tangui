import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { apply } from '../lib/index.js';

test('update settings use the DSH auth and origin checks and keep the normal plugin route usable', async t => {
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-http-'));
  const stateFile = join(root, 'state.json'); const disposers = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https://api.github.com/repos/bzny/dsh-plugin-tangui/') ?
    Promise.resolve(new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v0.4.0' }))) : nativeFetch(url, options);
  let route, origin;
  const server = createServer((req, res) => route(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const effect = setup => disposers.push(setup());
  const web = { effect,
    connection: { requestRejection(req) { return req.headers['x-fixture-session'] === 'yes' ? undefined : 401; } },
    webServer: { getOrigin: () => origin, register(config) { route = config.handler; return () => {}; } },
  };
  apply({ effect, inject(names, callback) { if (names.includes('webServer')) callback(web); } },
    { stateFile, memoryDir: '', platformUrl: '' });
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose?.();
    await new Promise(done => server.close(done));
    globalThis.fetch = nativeFetch;
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  });
  const endpoint = `${origin}/api/tangui/registration`;
  const request = (body, headers = {}) => nativeFetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-tangui-client': '1', 'x-fixture-session': 'yes', origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await nativeFetch(endpoint)).status, 401);
  assert.equal((await request({ action: 'update_auto', enabled: false }, { 'x-fixture-session': '' })).status, 401);
  assert.equal((await request({ action: 'update_auto', enabled: false }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request({ action: 'update_auto', enabled: 'false' })).status, 400);
  let response = await request({ action: 'update_auto', enabled: false }); assert.equal(response.status, 200);
  let state = await response.json(); assert.equal(state.updates.auto, false); assert.equal(state.updates.mode, 'development');
  assert.equal(JSON.parse(readFileSync(join(root, 'plugin-update.json'), 'utf8')).auto, false);
  response = await request({ action: 'update_check' }); assert.equal(response.status, 200);
  await new Promise(done => setImmediate(done));
  state = await (await nativeFetch(endpoint, { headers: { 'x-fixture-session': 'yes' } })).json();
  assert.equal(state.updates.latest, '0.4.0'); assert.equal(state.updates.current, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.equal(state.updates.state, 'current');
  assert.equal((await request({ action: 'update_hold', clientId: 'browser-fixture', editing: true })).status, 200);
  assert.equal((await request({ action: 'update_hold', clientId: '../x', editing: true })).status, 400);
  assert.equal((await request({ action: 'discover' })).status, 200);
});
