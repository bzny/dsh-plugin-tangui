import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateManager, compareVersions, UPDATE_INTERVAL_MS, isUpdateQuietHours } from '../lib/update-manager.js';

const commit = '1'.repeat(40), tagSha = '2'.repeat(40);
const api = 'https://api.github.com/repos/bzny/dsh-plugin-tangui';
const raw = `https://raw.githubusercontent.com/bzny/dsh-plugin-tangui/${commit}/package.json`;
const baseline = { name: 'dsh-plugin-tangui', version: '0.4.0', peerDependencies: { cordis: '^4.0.1' }, scripts: { test: 'node --test' } };
const newManifest = () => ({ ...baseline, version: '0.4.1' });
function fixture({ release = {}, manifest = newManifest(), ref = { object: { type: 'commit', sha: commit } }, extra = {}, fetchOverride } = {}) {
  const calls = [];
  const values = {
    [`${api}/releases/latest`]: { tag_name: 'v0.4.1', draft: false, prerelease: false, ...release },
    [`${api}/git/ref/tags/v0.4.1`]: ref,
    [raw]: manifest,
    ...extra,
  };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith(`${api}/`) || url.startsWith('https://raw.githubusercontent.com/bzny/dsh-plugin-tangui/'));
    if (fetchOverride) return fetchOverride(url, options);
    assert.ok(Object.hasOwn(values, url), `Unexpected request: ${url}`);
    return new Response(JSON.stringify(values[url]), { status: 200 });
  };
  return { fetchImpl, calls };
}
function hostFixture(overrides = {}) {
  const calls = []; let active = '0.4.0', installed = active;
  const host = {
    tryAcquireIdleLock() { calls.push('lock'); return () => calls.push('release'); },
    async snapshot() { calls.push('snapshot'); return { version: active }; },
    async install(target) { calls.push('install'); assert.equal(target.spec, `github:bzny/dsh-plugin-tangui#${commit}`); installed = target.version; },
    async activate() { calls.push('activate'); active = installed; },
    async getActiveVersion() { calls.push('version'); return active; },
    async restore(snapshot) { calls.push('restore'); installed = snapshot.version; },
    ...overrides,
  };
  return { host, calls, setActive: value => { active = value; } };
}
function manager(options = {}) {
  return new UpdateManager({ currentVersion: '0.4.0', currentManifest: baseline, mode: 'managed', now: () => 100, ...options });
}

test('numeric semver ordering is strict and prerelease/build syntax is not stable', () => {
  assert.equal(compareVersions('0.10.0', '0.9.20'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.4.0', '1.0.0'), -1);
  for (const value of ['01.2.3', 'v1.2.3', '1.2.3-rc.1', '1.2.3+build', 'main', '1.2']) assert.throws(() => compareVersions(value, '1.0.0'));
});

test('fixed repository ignores hostile release URLs and installs immutable SHA only', async () => {
  const net = fixture({ release: { tarball_url: 'https://evil.invalid/code', html_url: 'https://evil.invalid' } });
  const host = hostFixture(); const m = manager({ ...net, host: host.host });
  const result = await m.check();
  assert.equal(result.state, 'updated'); assert.equal(result.current, '0.4.1');
  assert.equal(result.candidate.url, 'https://github.com/bzny/dsh-plugin-tangui/releases/tag/v0.4.1');
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'activate', 'version', 'release']);
  assert.equal(net.calls.length, 3);
});

test('annotated tags resolve to commit with bounded traversal', async () => {
  const net = fixture({ ref: { object: { type: 'tag', sha: tagSha } }, extra: { [`${api}/git/tags/${tagSha}`]: { object: { type: 'commit', sha: commit } } } });
  assert.equal((await manager({ ...net }).check()).latest, '0.4.1');
  const loop = fixture({ ref: { object: { type: 'tag', sha: tagSha } }, extra: { [`${api}/git/tags/${tagSha}`]: { object: { type: 'tag', sha: tagSha } } } });
  const result = await manager({ ...loop }).check();
  assert.equal(result.error, 'invalid_release_commit'); assert.equal(loop.calls.length, 5);
});

test('draft, prerelease, branch, injected and noncanonical tags cannot install', async () => {
  for (const release of [{ draft: true }, { prerelease: true }, { tag_name: 'main' }, { tag_name: 'v0.4.1-rc.1' }, { tag_name: 'v0.4.1/path' }, { tag_name: 'v00.4.1' }]) {
    const net = fixture({ release }), host = hostFixture();
    assert.equal((await manager({ ...net, host: host.host }).check()).error, 'stable_release_required');
    assert.equal(host.calls.length, 0); assert.equal(net.calls.length, 1);
  }
});

test('equal or older release never fetches code or downgrades', async () => {
  for (const tag_name of ['v0.4.0', 'v0.3.9']) {
    const net = fixture({ release: { tag_name } }), host = hostFixture();
    assert.equal((await manager({ ...net, host: host.host }).check()).state, 'current');
    assert.equal(net.calls.length, 1); assert.deepEqual(host.calls, []);
  }
});

test('package identity, install scripts and changed runtime dependencies require manual review', async () => {
  for (const [change, code] of [
    [{ name: 'another-package' }, 'package_identity_mismatch'],
    [{ version: '0.9.0' }, 'package_identity_mismatch'],
    [{ scripts: { postinstall: 'run-code' } }, 'manual_required_install_scripts'],
    [{ scripts: { prepare: 'run-code' } }, 'manual_required_install_scripts'],
    [{ dependencies: { anything: '*' } }, 'manual_required_dependencies'],
    [{ optionalDependencies: { anything: '*' } }, 'manual_required_dependencies'],
    [{ peerDependencies: { cordis: '*' } }, 'manual_required_dependencies'],
    [{ pnpm: { overrides: { anything: '*' } } }, 'manual_required_dependencies'],
  ]) {
    const host = hostFixture(), net = fixture({ manifest: { ...newManifest(), ...change } });
    assert.equal((await manager({ ...net, host: host.host }).check()).error, code);
    assert.deepEqual(host.calls, []);
  }
});

test('offline and HTTP errors never return response bodies or raw exception text', async () => {
  for (const fetchImpl of [async () => { throw Error('secret in error'); }, async () => new Response('secret body', { status: 503 })]) {
    const result = await manager({ fetchImpl }).check();
    assert.equal(result.state, 'error'); assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test('timeout, redirected response and oversized streamed body are rejected', async () => {
  const timeout = await manager({ timeoutMs: 5, fetchImpl: async (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))) }).check();
  assert.equal(timeout.error, 'request_timeout');
  const redirect = await manager({ fetchImpl: async () => ({ ok: true, redirected: true }) }).check();
  assert.equal(redirect.error, 'invalid_update_source');
  const size = await manager({ maxResponseBytes: 128, fetchImpl: async () => new Response('x'.repeat(129)) }).check();
  assert.equal(size.error, 'response_too_large');
});

test('development link and unavailable host are check-only', async () => {
  const host = hostFixture();
  const development = await manager({ ...fixture(), mode: 'development', host: host.host }).check();
  assert.equal(development.state, 'available'); assert.equal(development.reason, 'development_check_only'); assert.equal(host.calls.length, 0);
  const absent = await manager({ ...fixture() }).check();
  assert.equal(absent.state, 'available'); assert.equal(absent.reason, 'host_check_only');
  const unsupported = manager({ ...fixture(), mode: 'check-only', host: host.host });
  assert.equal((await unsupported.check()).reason, 'host_check_only');
  assert.equal(unsupported.status().mode, 'check-only');
  assert.equal(unsupported.canInstall(), false); assert.equal(host.calls.length, 0);
});

test('waits for idle, then installs once without fetching release again', async () => {
  let idle = false;
  const host = hostFixture({ tryAcquireIdleLock() { return idle ? () => {} : null; } });
  const net = fixture(), m = manager({ ...net, host: host.host });
  assert.equal((await m.check()).state, 'waiting_idle'); assert.equal(host.calls.length, 0);
  idle = true;
  assert.equal((await m.tick()).state, 'updated'); assert.equal(net.calls.length, 3);
  await m.tick(); assert.equal(host.calls.filter(x => x === 'install').length, 1);
});

test('explicit check can defer install and auto false stops queued update', async () => {
  const host = hostFixture(), m = manager({ ...fixture(), host: host.host });
  assert.equal((await m.check({ install: false })).state, 'available'); assert.equal(host.calls.length, 0);
  m.setAuto(false); await m.tick(); assert.equal(host.calls.length, 0);
  m.setAuto(true); assert.equal((await m.tick()).state, 'updated');
});

test('manual install uses the displayed fixed candidate without enabling automatic updates', async () => {
  const net = fixture(), host = hostFixture(), m = manager({ ...net, host: host.host, auto: false });
  assert.equal(m.canInstall(), false);
  assert.equal((await m.check({ install: false, manual: true })).reason, 'auto_disabled');
  assert.equal(m.canInstall(), true); const calls = net.calls.length;
  const result = await m.install({ version: '0.4.1', commit });
  assert.equal(result.state, 'updated'); assert.equal(result.auto, false);
  assert.equal(net.calls.length, calls); assert.equal(host.calls.filter(x => x === 'install').length, 1);
  assert.equal(m.canInstall(), false);
});

test('manual install rejects stale targets and concurrent clicks without duplicate writes', async () => {
  const host = hostFixture(), m = manager({ ...fixture(), host: host.host, auto: false });
  assert.throws(() => m.install({ version: '0.4.1', commit }), { code: 'update_candidate_changed' });
  await m.check({ install: false, manual: true });
  assert.throws(() => m.install({ version: '0.4.2', commit }), { code: 'update_candidate_changed' });
  assert.throws(() => m.install({ version: '0.4.1', commit: '3'.repeat(40) }), { code: 'update_candidate_changed' });
  assert.equal(host.calls.length, 0);
  const first = m.install({ version: '0.4.1', commit });
  assert.throws(() => m.install({ version: '0.4.1', commit }), { code: 'update_busy' });
  await first; assert.equal(host.calls.filter(x => x === 'install').length, 1);
});

test('an explicitly requested manual update waits for the current action even while auto is off', async () => {
  let busy = true; const host = hostFixture({ tryAcquireIdleLock() { return busy ? null : () => {}; } });
  const m = manager({ ...fixture(), host: host.host, auto: false });
  await m.check({ install: false, manual: true });
  assert.equal((await m.install({ version: '0.4.1', commit })).state, 'waiting_idle');
  assert.equal(host.calls.length, 0); busy = false;
  assert.equal((await m.tick()).state, 'updated');
  assert.ok(host.calls.length > 0); assert.equal(m.auto, false);
  const count = host.calls.length; await m.tick(); assert.equal(host.calls.length, count);
});

test('manual entry keeps development, unsupported-host and restart conditions intact', async () => {
  for (const [mode, supported, reason] of [['development', true, 'development_check_only'], ['check-only', true, 'host_check_only'], ['managed', false, 'host_check_only']]) {
    const host = hostFixture(), m = manager({ ...fixture(), mode, host: supported ? host.host : null, auto: false });
    await m.check({ install: false, manual: true }); assert.equal(m.canInstall(), false);
    assert.equal((await m.install({ version: '0.4.1', commit })).reason, reason);
    assert.equal(host.calls.length, 0);
  }
  const host = hostFixture({ async install() { host.calls.push('install'); return { restartRequired: true }; } });
  const m = manager({ ...fixture(), host: host.host, auto: false });
  await m.check({ install: false, manual: true }); await m.install({ version: '0.4.1', commit });
  assert.equal(m.canInstall(), false);
  assert.throws(() => m.install({ version: '0.4.1', commit }), { code: 'update_restart_required' });
  assert.equal(host.calls.filter(x => x === 'install').length, 1);
});

test('failed manual install rolls back once and requires a new explicit check before retry', async () => {
  const host = hostFixture({ async install() { host.calls.push('install'); throw Error('failed'); } });
  const m = manager({ ...fixture(), host: host.host, auto: false });
  await m.check({ install: false, manual: true });
  assert.equal((await m.install({ version: '0.4.1', commit })).state, 'rolled_back');
  assert.equal(m.canInstall(), false);
  assert.throws(() => m.install({ version: '0.4.1', commit }), { code: 'update_retry_requires_check' });
  await m.check({ install: false, manual: true }); assert.equal(m.canInstall(), true);
  assert.equal(host.calls.filter(x => x === 'install').length, 1);
});

test('asynchronous idle acquisition is not accepted as an installation lock', async () => {
  const host = hostFixture({ tryAcquireIdleLock: async () => () => {} });
  const result = await manager({ ...fixture(), host: host.host }).check();
  assert.equal(result.error, 'idle_lock_must_be_synchronous'); assert.equal(host.calls.length, 0);
});

test('install failure restores backup, reactivates and verifies old version', async () => {
  const host = hostFixture({ async install() { host.calls.push('install'); throw Error('raw private path'); } });
  const net = fixture(), m = manager({ ...net, host: host.host });
  const result = await m.check();
  assert.equal(result.state, 'rolled_back'); assert.equal(result.current, '0.4.0'); assert.equal(result.blockedVersion, '0.4.1');
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'restore', 'activate', 'version', 'release']);
  await m.tick(); await m.check(); assert.equal(host.calls.filter(x => x === 'install').length, 1);
  await m.check({ manual: true }); assert.equal(host.calls.filter(x => x === 'install').length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private path/);
});

test('failed recovery is not misreported as rollback or update success', async () => {
  const host = hostFixture({ async install() { throw Error('failed'); }, async restore() { throw Error('failed'); } });
  const result = await manager({ ...fixture(), host: host.host }).check();
  assert.equal(result.state, 'error'); assert.equal(result.error, 'rollback_failed'); assert.equal(result.reason, 'recovery_required');
});

test('user source change after backup is preserved without restoring or activating', async () => {
  const host = hostFixture({ async install() {
    host.calls.push('install');
    throw Object.assign(Error('private source path'), { code: 'update_source_changed', skipRollback: true });
  } });
  const m = manager({ ...fixture(), host: host.host });
  const result = await m.check();
  assert.equal(result.state, 'error'); assert.equal(result.reason, 'installation_changed');
  assert.equal(result.error, 'update_source_changed'); assert.equal(result.current, '0.4.0');
  assert.equal(result.blockedVersion, '0.4.1');
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'release']);
  assert.equal(host.calls.filter(value => value === 'restore').length, 0);
  await m.tick(); assert.equal(host.calls.filter(value => value === 'install').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private source path/);
});

test('installation rejected before package writes does not restore a backup', async () => {
  const host = hostFixture({ async install() {
    host.calls.push('install');
    throw Object.assign(Error('private lock details'), { code: 'update_install_not_started', skipRollback: true });
  } });
  const result = await manager({ ...fixture(), host: host.host }).check();
  assert.equal(result.state, 'error'); assert.equal(result.reason, 'installation_unavailable');
  assert.equal(result.error, 'update_install_not_started'); assert.equal(result.blockedVersion, '0.4.1');
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'release']);
  assert.equal(host.calls.filter(value => value === 'restore').length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private lock details/);
});

test('restart required never claims active version changed and does not repeat install', async () => {
  const host = hostFixture({ async install() { host.calls.push('install'); return { restartRequired: true }; } });
  const m = manager({ ...fixture(), host: host.host });
  const result = await m.check();
  assert.equal(result.state, 'restarting_needed'); assert.equal(result.current, '0.4.0'); assert.equal(result.pendingVersion, '0.4.1');
  await m.tick(); await m.check(); assert.equal(host.calls.filter(x => x === 'install').length, 1);
  m.setCurrentVersion('0.4.1'); assert.equal(m.status().state, 'updated');
});

test('rollback needing restart stays pending until old code confirms activation', async () => {
  const host = hostFixture({ async install() { throw Error('install failed'); }, async restore() { return { restartRequired: true }; } });
  const m = manager({ ...fixture(), host: host.host });
  const result = await m.check();
  assert.equal(result.state, 'restarting_needed'); assert.equal(result.reason, 'rollback_restart_required');
  assert.equal(result.rollbackPending, true); assert.equal(result.blockedVersion, '0.4.1');
  const restored = manager({ initialState: result });
  assert.equal(restored.status().state, 'rolled_back'); assert.equal(restored.status().rollbackPending, false);
  m.setCurrentVersion('0.4.0'); assert.equal(m.status().state, 'rolled_back');
});

test('the verified installed manifest becomes the dependency baseline for next release', async () => {
  const host = hostFixture(), m = manager({ ...fixture({ manifest: { ...newManifest(), peerDependencies: {} } }), host: host.host });
  assert.equal((await m.check()).state, 'updated');
  const net = fixture({ release: { tag_name: 'v0.4.2' }, manifest: { ...newManifest(), version: '0.4.2' },
    extra: { [`${api}/git/ref/tags/v0.4.2`]: { object: { type: 'commit', sha: commit } } } });
  m.fetchImpl = net.fetchImpl;
  assert.equal((await m.check()).error, 'manual_required_dependencies');
  assert.equal(host.calls.filter(value => value === 'install').length, 1);
});

test('activation mismatch triggers recovery and backup failure does not mutate installation', async () => {
  let first = true;
  const host = hostFixture({ async getActiveVersion() { if (first) { first = false; return '0.4.0'; } return '0.4.0'; } });
  assert.equal((await manager({ ...fixture(), host: host.host }).check()).error, 'activation_version_mismatch');
  const backup = hostFixture({ async snapshot() { throw Error('disk'); } });
  assert.equal((await manager({ ...fixture(), host: backup.host }).check()).error, 'backup_failed');
  assert.deepEqual(backup.calls, ['lock', 'release']);
});

test('interval, persistence and concurrent calls share one operation', async () => {
  assert.equal(UPDATE_INTERVAL_MS, 60 * 60 * 1000);
  let now = 100; const changes = [], net = fixture({ release: { tag_name: 'v0.4.0' } });
  const m = manager({ ...net, now: () => now, onChange: state => changes.push(state) });
  await Promise.all([m.tick(), m.check(), m.tick()]); assert.equal(net.calls.length, 1);
  now += UPDATE_INTERVAL_MS - 1; await m.tick(); assert.equal(net.calls.length, 1);
  now++; await m.tick(); assert.equal(net.calls.length, 2);
  m.setAuto(false);
  const restored = manager({ ...fixture(), initialState: m.status() });
  assert.equal(restored.status().auto, false); assert.ok(changes.length > 0);
  assert.equal(manager({ initialState: { pendingVersion: '0.4.1' } }).status().state, 'restarting_needed');
  assert.equal(manager({ currentVersion: '0.4.1', initialState: { pendingVersion: '0.4.1' } }).status().state, 'updated');
});

test('quiet hours use Beijing time with inclusive 01:00 and exclusive 07:00 boundaries', () => {
  for (const [utc, expected] of [
    ['2026-10-28T16:59:59.999Z', false],
    ['2026-10-28T17:00:00.000Z', true],
    ['2026-10-28T22:59:59.999Z', true],
    ['2026-10-28T23:00:00.000Z', false],
    ['2026-10-29T00:00:00.000Z', false],
  ]) assert.equal(isUpdateQuietHours(Date.parse(utc)), expected, utc);
});

test('automatic checks stay silent overnight and overdue work resumes at 07:00', async () => {
  let now = Date.parse('2026-10-29T01:00:00+08:00');
  const net = fixture({ release: { tag_name: 'v0.4.0' } });
  const m = manager({ ...net, now: () => now });
  await m.check(); await m.tick();
  assert.equal(net.calls.length, 0); assert.equal(m.status().lastCheck, null);
  now = Date.parse('2026-10-29T06:59:59.999+08:00');
  await m.tick(); assert.equal(net.calls.length, 0);
  now++; await m.tick();
  assert.equal(net.calls.length, 1); assert.equal(m.status().lastCheck, now);
  now += UPDATE_INTERVAL_MS - 1; await m.tick(); assert.equal(net.calls.length, 1);
  now++; await m.tick(); assert.equal(net.calls.length, 2);
});

test('manual checks and installs remain available overnight without enabling auto', async () => {
  const net = fixture(), host = hostFixture();
  const m = manager({ ...net, host: host.host, auto: false, now: () => Date.parse('2026-10-29T03:00:00+08:00') });
  await m.check(); await m.tick(); assert.equal(net.calls.length, 0);
  assert.equal((await m.check({ manual: true, install: false })).state, 'available');
  assert.equal(m.canInstall(), true); assert.equal(net.calls.length, 3);
  const result = await m.install({ version: '0.4.1', commit });
  assert.equal(result.state, 'updated'); assert.equal(result.auto, false);
  assert.equal(host.calls.filter(value => value === 'install').length, 1);
});

test('a candidate waiting for idle cannot install during quiet hours', async () => {
  let now = Date.parse('2026-10-29T00:30:00+08:00'), busy = true;
  const host = hostFixture({ tryAcquireIdleLock() { host.calls.push('lock'); return busy ? null : () => host.calls.push('release'); } });
  const net = fixture(), m = manager({ ...net, host: host.host, now: () => now });
  assert.equal((await m.check()).state, 'waiting_idle');
  now = Date.parse('2026-10-29T01:00:00+08:00'); busy = false;
  await m.tick(); assert.deepEqual(host.calls, ['lock']); assert.equal(net.calls.length, 3);
  now = Date.parse('2026-10-29T07:00:00+08:00');
  assert.equal((await m.tick()).state, 'updated'); assert.equal(net.calls.length, 6);
});

test('automatic candidate validation defers further requests when the clock crosses 01:00', async () => {
  let now = Date.parse('2026-10-29T00:59:59+08:00'), crossBoundary = true;
  const net = fixture(), host = hostFixture();
  const m = manager({ host: host.host, now: () => now, fetchImpl: async (url, options) => {
    const result = await net.fetchImpl(url, options);
    if (crossBoundary) { now = Date.parse('2026-10-29T01:00:00+08:00'); crossBoundary = false; }
    return result;
  } });
  const result = await m.check();
  assert.equal(result.state, 'current'); assert.equal(result.error, null); assert.equal(result.lastCheck, null);
  assert.equal(result.latest, null); assert.equal(net.calls.length, 1); assert.deepEqual(host.calls, []);
  now = Date.parse('2026-10-29T07:00:00+08:00');
  assert.equal((await m.tick()).state, 'updated'); assert.equal(net.calls.length, 4);
});

test('metadata completed at 01:00 does not trigger automatic installation until 07:00', async () => {
  let now = Date.parse('2026-10-29T00:59:59+08:00'), crossBoundary = true;
  const net = fixture(), host = hostFixture();
  const m = manager({ host: host.host, now: () => now, fetchImpl: async (url, options) => {
    const result = await net.fetchImpl(url, options);
    if (url === raw && crossBoundary) { now = Date.parse('2026-10-29T01:00:00+08:00'); crossBoundary = false; }
    return result;
  } });
  assert.equal((await m.check()).state, 'available'); assert.deepEqual(host.calls, []);
  now = Date.parse('2026-10-29T07:00:00+08:00');
  assert.equal((await m.tick()).state, 'updated'); assert.equal(net.calls.length, 6);
});

test('available candidates still check for newer releases once per hour', async () => {
  let now = Date.parse('2026-10-29T10:00:00+08:00');
  const net = fixture(), m = manager({ ...net, mode: 'development', now: () => now });
  await m.tick(); assert.equal(net.calls.length, 3);
  now += UPDATE_INTERVAL_MS - 1; await m.tick(); assert.equal(net.calls.length, 3);
  now++; await m.tick(); assert.equal(net.calls.length, 6);
});

test('automatic installation rechecks quiet hours after taking the idle lock', async () => {
  let now = Date.parse('2026-10-29T00:59:59+08:00');
  const host = hostFixture({ tryAcquireIdleLock() {
    host.calls.push('lock'); now = Date.parse('2026-10-29T01:00:00+08:00');
    return () => host.calls.push('release');
  } });
  const m = manager({ ...fixture(), host: host.host, now: () => now });
  assert.equal((await m.check()).state, 'available'); assert.deepEqual(host.calls, ['lock', 'release']);
});

test('installation already started before quiet hours completes its transaction', async () => {
  let now = Date.parse('2026-10-29T00:59:59+08:00');
  const host = hostFixture({ async snapshot() {
    host.calls.push('snapshot'); now = Date.parse('2026-10-29T01:00:00+08:00'); return { version: '0.4.0' };
  } });
  const m = manager({ ...fixture(), host: host.host, now: () => now });
  assert.equal((await m.check()).state, 'updated');
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'activate', 'version', 'release']);
});

test('activation failure retains its stage after successful recovery, later checks and reload', async () => {
  let now = 100, activations = 0;
  const host = hostFixture({ async activate() {
    now += 20;
    if (++activations === 1) throw Object.assign(Error('secret path and token'), { code: 'ERR_MODULE_NOT_FOUND' });
  } });
  const m = manager({ ...fixture(), host: host.host, now: () => now });
  const result = await m.check();
  assert.equal(result.state, 'rolled_back');
  assert.deepEqual(result.lastAttempt.failure, { stage: 'activate', code: 'unknown', systemCode: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(result.lastAttempt.outcome, 'rolled_back');
  assert.equal(result.lastAttempt.startedAt, 100); assert.equal(result.lastAttempt.finishedAt, 140);
  assert.deepEqual(result.lastAttempt.steps.map(value => value.stage),
    ['snapshot', 'install', 'activate', 'restore', 'restore_activate', 'restore_verify']);
  await m.check({ install: false, manual: true });
  assert.deepEqual(m.status().lastAttempt, result.lastAttempt);
  const reloaded = manager({ initialState: m.status() });
  assert.deepEqual(reloaded.status().lastAttempt, result.lastAttempt);
  assert.doesNotMatch(JSON.stringify(result), /secret|token/);
});

test('failed recovery keeps both the original failure and recovery stage without raw error data', async () => {
  const host = hostFixture({
    async install() { throw Object.assign(Error('private installer output'), { updateDiagnosticCode: 'installer_exit', exitCode: 7 }); },
    async restore() { throw Object.assign(Error('private backup path'), { code: 'EACCES' }); },
  });
  const result = await manager({ ...fixture(), host: host.host }).check();
  assert.equal(result.state, 'error'); assert.equal(result.error, 'rollback_failed');
  assert.deepEqual(result.lastAttempt.failure, { stage: 'install', code: 'installer_exit', exitCode: 7 });
  assert.deepEqual(result.lastAttempt.recoveryFailure, { stage: 'restore', code: 'unknown', systemCode: 'EACCES' });
  assert.equal(result.lastAttempt.outcome, 'recovery_required');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('backup and live-version failures are distinguishable and do not add retry calls', async () => {
  const backup = hostFixture({ async snapshot() { throw Object.assign(Error('private disk path'), { code: 'ENOSPC' }); } });
  const result = await manager({ ...fixture(), host: backup.host }).check();
  assert.equal(result.error, 'backup_failed'); assert.equal(result.lastAttempt.outcome, 'error');
  assert.deepEqual(result.lastAttempt.failure, { stage: 'snapshot', code: 'unknown', systemCode: 'ENOSPC' });
  assert.deepEqual(backup.calls, ['lock', 'release']);
  const mismatch = hostFixture({ getActiveVersion() { return '0.4.0'; } });
  const m = manager({ ...fixture(), host: mismatch.host });
  const failed = await m.check();
  assert.deepEqual(failed.lastAttempt.failure, { stage: 'verify', code: 'activation_version_mismatch' });
  const before = mismatch.calls.length; await m.tick(); assert.equal(mismatch.calls.length, before);
});

test('restart confirmation updates the attempt outcome; diagnostic persistence failures do not change the update', async () => {
  const host = hostFixture({ async install() { return { restartRequired: true }; } });
  const result = await manager({ ...fixture(), host: host.host, onChange() { throw Error('unwritable log'); } }).check();
  assert.equal(result.state, 'restarting_needed'); assert.equal(result.lastAttempt.outcome, 'restart_required');
  const restarted = new UpdateManager({ currentVersion: '0.4.1', currentManifest: newManifest(), initialState: result, now: () => 200 });
  assert.equal(restarted.status().lastAttempt.outcome, 'updated');
  assert.equal(restarted.status().lastAttempt.finishedAt, 200);
  assert.equal(restarted.status().lastAttempt.failure, null);
});

test('successful update keeps a bounded attempt with no failure', async () => {
  const host = hostFixture(), m = manager({ ...fixture(), host: host.host });
  const result = await m.check();
  assert.deepEqual(result.lastAttempt, { from: '0.4.0', to: '0.4.1', startedAt: 100, finishedAt: 100,
    stage: 'verify', outcome: 'updated', failure: null, recoveryFailure: null,
    steps: ['snapshot', 'install', 'activate', 'verify'].map(stage => ({ stage, at: 100 })) });
  assert.deepEqual(host.calls, ['lock', 'snapshot', 'install', 'activate', 'version', 'release']);
});
