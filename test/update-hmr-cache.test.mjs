import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function exerciseHostCache() {
  // Use DSH's actual dependency graph and cache eviction, rather than a mock
  // that reports the requested version as soon as installation succeeds.
  const { default: Hmr } = await import('@deepseek-ai/dsh-hmr');
  const require = createRequire(import.meta.url);
  const hmr = Object.create(Hmr.prototype);
  hmr.internal = require('internal/modules/esm/loader').getOrInitializeCascadedLoader();
  hmr.ctx = { loader: { entries: () => [], unwrapExports: value => value?.default ?? value }, registry: new Map() };
  hmr.hostModules = async () => new Set();
  const parent = resolve('.test-work'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'update-hmr-cache-'));
  const disposers = [];
  const manifestPath = join(root, 'package.json'), entryPath = join(root, 'index.js');
  const manifestUrl = pathToFileURL(manifestPath).href, entryUrl = pathToFileURL(entryPath).href;
  const helperPath = join(root, 'lib', 'update-integration.js');
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'local-state'));
  for (const name of ['update-integration.js', 'update-host.js', 'update-manager.js', 'update-gate.js', 'update-diagnostics.js']) {
    copyFileSync(join(here, '..', 'lib', name), join(root, 'lib', name));
  }
  const writeManifest = version => writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-plugin-tangui', type: 'module', version }));
  const writeEntry = revision => writeFileSync(entryPath, `import { setupUpdates } from './lib/update-integration.js';\nexport const revision = ${revision};\nexport const activate = setupUpdates;\n`);
  writeManifest('0.5.11'); writeEntry(1);
  writeFileSync(join(root, 'local-state', 'plugin-update.json'), JSON.stringify({ auto: false }));
  const context = () => ({ get: name => name === 'profileContext' ? { dir: root } : undefined,
    effect(setup) { disposers.push(setup()); } });
  const options = { stateFile: join(root, 'local-state', 'state.json'), isBusy: () => false,
    createAdapter: () => ({ mode: 'check-only', reason: 'isolated-host-cache-test', profileDir: root, host: null }) };
  const start = entry => { const updates = entry.activate(context(), options); updates.ready(); return updates; };
  const replaceChangedModules = async changed => {
    const loaded = hmr.profileModules([root + sep]);
    const stale = loaded.filter(url => changed.includes(url));
    const plan = await hmr.planReplacement(stale, [root + sep]);
    assert.deepEqual(plan.pending, []);
    disposers.splice(0).forEach(dispose => dispose());
    hmr.evict(plan.evicted);
    return import(entryUrl);
  };
  try {
    let entry = await import(entryUrl), updates = start(entry);
    assert.equal(updates.status().current, '0.5.11');
    const originalHelper = readFileSync(helperPath);
    writeManifest('0.5.14'); writeEntry(2);
    assert.equal(updates.status().current, '0.5.11', 'files installed on disk are not proof of active code');
    entry = await replaceChangedModules([manifestUrl, entryUrl]); updates = start(entry);
    assert.equal(entry.revision, 2, 'the new entry really was evaluated');
    assert.equal(updates.status().current, '0.5.14', 'a reused update helper must not report the previous release');
    assert.deepEqual(readFileSync(helperPath), originalHelper, 'no artificial updater-source change masks the cache bug');
    // A later release may change just metadata. It must still invalidate the
    // version dependency and activate the right identity.
    writeManifest('0.5.15');
    assert.equal(updates.status().current, '0.5.14');
    entry = await replaceChangedModules([manifestUrl]); updates = start(entry);
    assert.equal(entry.revision, 2);
    assert.equal(updates.status().current, '0.5.15');
    console.log(JSON.stringify({ entryReload: '0.5.11 -> 0.5.14', unchangedJavaScriptReload: '0.5.14 -> 0.5.15', result: 'passed' }));
  } finally {
    disposers.splice(0).forEach(dispose => dispose());
    hmr.evict(hmr.profileModules([root + sep]));
    globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')]?.delete(process.platform === 'win32' ? root.toLowerCase() : root);
    assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true });
  }
}

if (process.argv.includes('--hmr-cache-worker')) {
  await exerciseHostCache();
} else {
  test('real DSH HMR refreshes release identity when the updater JavaScript is unchanged', { timeout: 30000 }, () => {
    const child = spawnSync(process.execPath, ['--expose-internals', '--import', pathToFileURL(join(here, 'host-modules.mjs')).href,
      fileURLToPath(import.meta.url), '--hmr-cache-worker'], { encoding: 'utf8', timeout: 25000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
    assert.match(child.stdout, /"result":"passed"/);
  });
}
