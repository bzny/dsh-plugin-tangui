import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverMemorySource } from '../lib/memory-source.js';

const workspace = resolve(tmpdir(), 'tangui-source-fixture', 'workspace');
const home = resolve(tmpdir(), 'tangui-source-fixture', 'home');
const folder = (name) => resolve(tmpdir(), 'tangui-source-fixture', name);
const configured = folder('configured');
const environment = folder('environment');
const actual = folder('actual');
const local = join(workspace, '.memory');
const required = (dir) => [join(dir, 'SOUL.md'), join(dir, 'BOOTSTRAP.md')];
const discover = (options = {}, files = []) => {
  const present = new Set(files);
  return discoverMemorySource({ cwd: workspace, home, env: {}, exists: (path) => present.has(path), ...options });
};
const activeLoader = (config = {}) => ({ entries: function* () {
  yield { options: { name: 'dsh-plugin-memory', config }, fiber: { state: 2, config }, disabled: false };
} });

test('live memory config wins over composition and environment; no config-file reads', () => {
  const result = discover({ loader: activeLoader({ memoryDir: configured, configFile: 'do-not-read.json' }),
    memoryConfig: { enabled: true, memoryDir: actual }, env: { MEMORY_DIR: environment } },
  [...required(actual), ...required(configured), ...required(environment)]);
  assert.equal(result.status, 'ready');
  assert.equal(result.memoryDir, actual);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'memory_plugin_runtime');
});

test('loaded memory composition is not mistaken for hot-edited runtime configuration', () => {
  const result = discover({ loader: activeLoader({ memoryDir: configured }) }, required(configured));
  assert.equal(result.status, 'needs_memory_config');
  assert.equal(result.memoryConfigRequired, true);
  assert.equal(result.memoryDir, undefined);
  assert.equal(result.candidates[0].authoritative, false);
});

test('an existing bound directory stays pinned even if another source changes', () => {
  const result = discover({ selectedMemoryDir: configured, loader: activeLoader(),
    memoryConfig: { memoryDir: actual }, env: { MEMORY_DIR: environment } },
  [...required(configured), ...required(actual), ...required(environment)]);
  assert.equal(result.status, 'ready');
  assert.equal(result.memoryDir, configured);
  assert.equal(result.candidates.length, 1);
});

test('missing bound files never switch the account to another persona', () => {
  const result = discover({ selectedMemoryDir: configured, memoryConfig: { memoryDir: actual } }, required(actual));
  assert.equal(result.status, 'not_found');
  assert.equal(result.memoryDir, configured);
  assert.equal(result.candidates[0].available, false);
});

test('fallback accepts an explicit path or MEMORY_DIR or local folder only with both files', () => {
  for (const [options, expected] of [
    [{ explicitMemoryDir: configured }, configured],
    [{ env: { MEMORY_DIR: environment } }, environment],
    [{}, local],
  ]) {
    const result = discover(options, required(expected));
    assert.equal(result.status, 'ready');
    assert.equal(result.memoryDir, expected);
  }
  const partial = discover({}, [join(local, 'SOUL.md')]);
  assert.equal(partial.status, 'not_found');
  assert.equal(partial.memoryDir, undefined);
  assert.deepEqual(partial.candidates[0].missing, ['BOOTSTRAP.md']);
});

test('distinct valid fallback sources require selection, with deterministic priority ordering', () => {
  const result = discover({ explicitMemoryDir: configured, env: { MEMORY_DIR: environment } },
    [...required(configured), ...required(environment), ...required(local)]);
  assert.equal(result.status, 'needs_selection');
  assert.equal(result.memoryDir, undefined);
  assert.deepEqual(result.candidates.map((item) => item.source), ['explicit', 'environment', 'workspace']);
});

test('explicit and runtime disagreement requires selection, and identical paths are merged', () => {
  const conflict = discover({ explicitMemoryDir: configured, memoryConfig: { memoryDir: actual } },
    [...required(configured), ...required(actual)]);
  assert.equal(conflict.status, 'needs_selection');
  const same = discover({ explicitMemoryDir: actual, memoryConfig: { memoryDir: actual } }, required(actual));
  assert.equal(same.status, 'ready');
  assert.equal(same.candidates.length, 1);
  assert.deepEqual(same.candidates[0].sources, ['explicit', 'memory_plugin_runtime']);
});

test('incomplete explicit source cannot silently fall through to another usable partner', () => {
  const result = discover({ explicitMemoryDir: configured, env: { MEMORY_DIR: environment } }, required(environment));
  assert.equal(result.status, 'needs_selection');
  assert.equal(result.memoryDir, undefined);
});

test('tilde and relative paths resolve without assuming package installation layout', () => {
  const byHome = discover({ explicitMemoryDir: '~/.memory' }, required(join(home, '.memory')));
  assert.equal(byHome.memoryDir, join(home, '.memory'));
  const byRelative = discover({ explicitMemoryDir: 'partner' }, required(join(workspace, 'partner')));
  assert.equal(byRelative.memoryDir, join(workspace, 'partner'));
  const unavailable = discover({}, required(join(home, '.memory')));
  assert.equal(unavailable.status, 'not_found');
});

test('disabled and unrecognized providers need a deliberate selection or explicit generic path', () => {
  const disabled = discover({ memoryConfig: { enabled: false, memoryDir: actual } }, required(actual));
  assert.equal(disabled.status, 'needs_selection');
  assert.equal(disabled.memoryDir, undefined);
  const other = discover({ explicitMemoryDir: configured, loader: { entries: function* () {
    yield { options: { name: 'some-other-memory' }, fiber: { state: 2, config: { memoryDir: actual } } };
  } } }, [...required(configured), ...required(actual)]);
  assert.equal(other.status, 'ready');
  assert.equal(other.memoryDir, configured);
});

test('malformed runtime config and unreadable metadata do not become ready', () => {
  assert.equal(discover({ memoryConfig: {} }).status, 'needs_memory_config');
  assert.equal(discover({ explicitMemoryDir: configured, exists() { throw Error('denied'); } }).status, 'not_found');
  const brokenLoader = discover({ loader: { entries() { throw Error('not ready'); } } }, required(local));
  assert.equal(brokenLoader.status, 'needs_memory_config');
  assert.equal(brokenLoader.memoryDir, undefined);
});
