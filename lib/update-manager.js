/** Release-only update coordination. Filesystem and DSH effects belong to host. */
import { restoreUpdateAttempt, updateFailure } from './update-diagnostics.js';

export const UPDATE_REPOSITORY = 'bzny/dsh-plugin-tangui';
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
export function isUpdateQuietHours(now) {
  // Beijing is UTC+8 year-round. Do not depend on the user's system timezone.
  const hour = new Date(now + 8 * 60 * 60 * 1000).getUTCHours();
  return hour >= 1 && hour < 7;
}
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const RAW = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}`;
const PACKAGE_NAME = 'dsh-plugin-tangui';
const INSTALL_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack', 'pnpm:devPreinstall']);
const HOST_METHODS = ['tryAcquireIdleLock', 'snapshot', 'install', 'activate', 'getActiveVersion', 'restore'];
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class UpdateError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function validVersion(version) {
  return typeof version === 'string' && version.length <= 64 && VERSION.test(version);
}
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) throw new UpdateError('invalid_version');
  const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isRestart(value) { return value?.restartRequired === true; }

function validateManifest(manifest, baseline, version) {
  if (!plain(manifest) || manifest.name !== PACKAGE_NAME || manifest.version !== version) throw new UpdateError('package_identity_mismatch');
  if (!plain(baseline) || baseline.name !== PACKAGE_NAME) throw new UpdateError('baseline_required');
  if (manifest.scripts !== undefined && !plain(manifest.scripts)) throw new UpdateError('package_manifest_invalid');
  if (Object.keys(manifest.scripts || {}).some(key => INSTALL_SCRIPTS.has(key))) throw new UpdateError('manual_required_install_scripts');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const next = manifest[field] ?? {}, previous = baseline[field] ?? {};
    if (!plain(next) || !plain(previous)) throw new UpdateError('package_manifest_invalid');
    for (const [name, range] of Object.entries(next)) {
      if (typeof range !== 'string' || !Object.hasOwn(previous, name) || range !== previous[name]) throw new UpdateError('manual_required_dependencies');
    }
  }
  // Bundled packages and package-manager overrides can introduce code outside
  // the visible dependency map, so these releases require explicit inspection.
  for (const field of ['bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'pnpm']) {
    if (manifest[field] !== undefined && JSON.stringify(manifest[field]) !== JSON.stringify(baseline[field])) throw new UpdateError('manual_required_dependencies');
  }
}

/**
 * host.tryAcquireIdleLock must return a release function (or {release})
 * synchronously. All other host methods may be async. No host method receives
 * state files or secrets. onChange receives a JSON-safe, non-secret snapshot.
 */
export class UpdateManager {
  constructor({ currentVersion, currentManifest, mode = 'check-only', host = null, fetchImpl = globalThis.fetch,
    now = Date.now, auto = true, checkIntervalMs = UPDATE_INTERVAL_MS, timeoutMs = 12000,
    maxResponseBytes = 256 * 1024, initialState = {}, onChange = null } = {}) {
    if (!validVersion(currentVersion)) throw new UpdateError('invalid_version');
    this.currentVersion = currentVersion;
    this.currentManifest = currentManifest;
    this.mode = ['managed', 'development'].includes(mode) ? mode : 'check-only';
    this.host = host; this.fetchImpl = fetchImpl; this.now = now; this.onChange = onChange;
    this.checkIntervalMs = Math.max(1000, Number(checkIntervalMs) || UPDATE_INTERVAL_MS);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 12000);
    this.maxResponseBytes = Math.max(128, Number(maxResponseBytes) || 256 * 1024);
    this.auto = typeof initialState.auto === 'boolean' ? initialState.auto : Boolean(auto);
    this.lastCheck = Number.isFinite(initialState.lastCheck) ? Math.min(initialState.lastCheck, this.now()) : null;
    this.blockedVersion = validVersion(initialState.blockedVersion) ? initialState.blockedVersion : null;
    this.pendingVersion = validVersion(initialState.pendingVersion) ? initialState.pendingVersion : null;
    this.latest = validVersion(initialState.latest) ? initialState.latest : null;
    this.candidate = null; this._candidateManifest = null; this._operation = null;
    this.lastAttempt = restoreUpdateAttempt(initialState.lastAttempt);
    this.state = 'current'; this.reason = null; this.error = null; this.rollbackPending = initialState.rollbackPending === true;
    if (this.pendingVersion) {
      if (this.pendingVersion === currentVersion) {
        this.state = this.rollbackPending ? 'rolled_back' : 'updated'; this.pendingVersion = null; this.rollbackPending = false;
        this._finishAttempt(this.state);
      } else { this.state = 'restarting_needed'; this.reason = this.rollbackPending ? 'rollback_restart_required' : 'restart_required'; }
    }
  }
  status() {
    return clone({ state: this.state, current: this.currentVersion, latest: this.latest, auto: this.auto,
      mode: this.mode, lastCheck: this.lastCheck, blockedVersion: this.blockedVersion,
      pendingVersion: this.pendingVersion, reason: this.reason, error: this.error,
      restartRequired: this.state === 'restarting_needed', rollbackPending: this.rollbackPending,
      candidate: this.candidate, lastAttempt: this.lastAttempt });
  }
  _emit() {
    const snapshot = this.status();
    try { Promise.resolve(this.onChange?.(snapshot)).catch(() => {}); } catch { /* UI persistence cannot break recovery. */ }
    return snapshot;
  }
  _set(state, reason = null, error = null) {
    this.state = state; this.reason = reason; this.error = error; return this._emit();
  }
  _stage(stage) {
    if (!this.lastAttempt) return;
    this.lastAttempt.stage = stage;
    this.lastAttempt.steps.push({ stage, at: this.now() });
    this._emit();
  }
  _finishAttempt(outcome) {
    if (!this.lastAttempt) return;
    this.lastAttempt.outcome = outcome; this.lastAttempt.finishedAt = this.now();
  }
  setAuto(value) { this.auto = Boolean(value); return this._emit(); }
  setCurrentVersion(version) {
    if (!validVersion(version)) throw new UpdateError('invalid_version');
    this.currentVersion = version;
    if (this.state !== 'installing' && this.pendingVersion === version) {
      this.pendingVersion = null;
      const recovered = this.rollbackPending; this.rollbackPending = false;
      this._finishAttempt(recovered ? 'rolled_back' : 'updated');
      return this._set(recovered ? 'rolled_back' : 'updated');
    }
    return this._emit();
  }
  async _json(url) {
    // Callers construct only these fixed paths. Reject redirect and alternate
    // origins as a second boundary, including malformed injected fetch inputs.
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.hash ||
      ![`${API}/`, `${RAW}/`].some(prefix => url.startsWith(prefix))) throw new UpdateError('invalid_update_source');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json' } });
      if (response.redirected) throw new UpdateError('invalid_update_source');
      if (response.url && response.url !== url) throw new UpdateError('invalid_update_source');
      if (!response.ok) throw new UpdateError(response.status === 404 ? 'release_unavailable' : 'release_request_failed');
      const contentLength = Number(response.headers?.get('content-length'));
      if (contentLength > this.maxResponseBytes) throw new UpdateError('response_too_large');
      if (!response.body?.getReader) throw new UpdateError('invalid_response');
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > this.maxResponseBytes) throw new UpdateError('response_too_large');
          chunks.push(value);
        }
      } finally { try { await reader.cancel(); } catch {} }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new UpdateError('invalid_response'); }
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      throw new UpdateError(controller.signal.aborted ? 'request_timeout' : 'network_unavailable');
    } finally { clearTimeout(timer); }
  }
  _automaticAllowed() { return this.auto && !isUpdateQuietHours(this.now()); }
  async _findRelease({ manual }) {
    // A response received after 01:00 must not start another automatic request.
    const json = url => {
      if (!manual && !this._automaticAllowed()) throw new UpdateError('automatic_update_deferred');
      return this._json(url);
    };
    const release = await json(`${API}/releases/latest`);
    if (!plain(release) || release.draft !== false || release.prerelease !== false ||
      typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v') || !validVersion(release.tag_name.slice(1))) throw new UpdateError('stable_release_required');
    const version = release.tag_name.slice(1);
    this.latest = version;
    if (compareVersions(version, this.currentVersion) <= 0) return null;
    const ref = await json(`${API}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
    let object = ref.object, depth = 0;
    while (object?.type === 'tag' && depth < 3) {
      if (!SHA.test(object.sha)) throw new UpdateError('invalid_release_commit');
      const tag = await json(`${API}/git/tags/${object.sha}`);
      object = tag.object; depth++;
    }
    if (object?.type !== 'commit' || !SHA.test(object.sha)) throw new UpdateError('invalid_release_commit');
    const commit = object.sha;
    const manifest = await json(`${RAW}/${commit}/package.json`);
    validateManifest(manifest, this.currentManifest, version);
    this._candidateManifest = manifest;
    return { version, tag: release.tag_name, commit, spec: `github:${UPDATE_REPOSITORY}#${commit}`,
      url: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${release.tag_name}` };
  }
  check({ install = this.auto, manual = false } = {}) {
    if (this._operation) return this._operation;
    if (!manual && !this._automaticAllowed()) return Promise.resolve(this.status());
    return this._run(async () => {
      if (!manual && !this._automaticAllowed()) return this.status();
      const previous = this.status();
      this.lastCheck = this.now(); this._set('checking');
      try {
        this.candidate = await this._findRelease({ manual });
        if (!this.candidate) return this._set('current');
        if (manual && this.blockedVersion === this.candidate.version) this.blockedVersion = null;
        if (this.pendingVersion === this.candidate.version) return this._set('restarting_needed', 'restart_required');
        const checkOnly = this._checkOnlyReason();
        this._set('available', checkOnly || (!this.auto ? 'auto_disabled' : null));
        return install ? this._install({ manual }) : this.status();
      } catch (error) {
        if (error?.code === 'automatic_update_deferred') {
          this.lastCheck = previous.lastCheck; this.latest = previous.latest;
          return this._set(previous.state, previous.reason, previous.error);
        }
        this.candidate = null; this._candidateManifest = null;
        return this._set('error', null, error instanceof UpdateError ? error.code : 'update_check_failed');
      }
    });
  }
  tick({ install = this.auto } = {}) {
    if (this._operation) return this._operation;
    if (!this._automaticAllowed() || this.pendingVersion) return Promise.resolve(this.status());
    if (this.lastCheck === null || this.now() - this.lastCheck >= this.checkIntervalMs) return this.check({ install });
    if (this.candidate && compareVersions(this.candidate.version, this.currentVersion) > 0) {
      return install ? this._run(() => this._install({ manual: false })) : Promise.resolve(this.status());
    }
    return Promise.resolve(this.status());
  }
  canInstall() {
    return Boolean(!this._operation && !this.pendingVersion && this.candidate &&
      compareVersions(this.candidate.version, this.currentVersion) > 0 &&
      this.blockedVersion !== this.candidate.version && this.mode === 'managed' && this.host &&
      HOST_METHODS.every(key => typeof this.host[key] === 'function'));
  }
  _checkOnlyReason() {
    if (this.mode === 'development') return 'development_check_only';
    return this.mode !== 'managed' || !this.host || HOST_METHODS.some(key => typeof this.host[key] !== 'function') ? 'host_check_only' : null;
  }
  install({ version, commit } = {}) {
    if (this._operation) throw new UpdateError('update_busy');
    if (this.pendingVersion) throw new UpdateError('update_restart_required');
    // Install only the release already checked and displayed to this user.
    // A stale tab cannot authorize a different/newer candidate implicitly.
    if (!this.candidate || version !== this.candidate.version || commit !== this.candidate.commit ||
      compareVersions(version, this.currentVersion) <= 0) throw new UpdateError('update_candidate_changed');
    if (this.blockedVersion === version) throw new UpdateError('update_retry_requires_check');
    return this._run(() => this._install({ manual: true }));
  }
  _run(action) {
    // Defer action until the promise is stored, including synchronously resolving
    // host mocks. All concurrent callers then join the same operation.
    const operation = Promise.resolve().then(action);
    this._operation = operation.finally(() => { this._operation = null; });
    return this._operation;
  }
  async _install({ manual }) {
    const target = this.candidate;
    if (!target || compareVersions(target.version, this.currentVersion) <= 0) return this._set('current');
    if (!this.auto && !manual) return this._set('available', 'auto_disabled');
    if (!manual && isUpdateQuietHours(this.now())) return this.status();
    const checkOnly = this._checkOnlyReason();
    if (checkOnly) return this._set('available', checkOnly);
    if (this.blockedVersion === target.version) return this.status();
    let lock;
    try { lock = this.host.tryAcquireIdleLock(); }
    catch { return this._set('error', null, 'idle_lock_failed'); }
    if (lock?.then) {
      // Do not mutate without a synchronously acquired lock. Release a delayed
      // lock if a malformed adapter eventually produces one.
      Promise.resolve(lock).then(value => typeof value === 'function' ? value() : value?.release?.()).catch(() => {});
      return this._set('error', null, 'idle_lock_must_be_synchronous');
    }
    if (!lock) return this._set('waiting_idle', 'runtime_busy');
    const release = typeof lock === 'function' ? lock : typeof lock.release === 'function' ? () => lock.release() : null;
    if (!release) return this._set('error', null, 'invalid_idle_lock');
    const oldVersion = this.currentVersion, oldManifest = this.currentManifest; let snapshot, backedUp = false;
    this.rollbackPending = false;
    try {
      // A UI change in the same turn can disable automatic installation before
      // the lock is taken. Once installing, finish or recover transactionally.
      if (!this.auto && !manual) return this._set('available', 'auto_disabled');
      if (!manual && isUpdateQuietHours(this.now())) return this.status();
      this.lastAttempt = { from: oldVersion, to: target.version, startedAt: this.now(), finishedAt: null,
        stage: 'snapshot', outcome: 'running', failure: null, recoveryFailure: null, steps: [] };
      this._set('installing');
      this._stage('snapshot');
      snapshot = await this.host.snapshot(); backedUp = true;
      this._stage('install');
      if (isRestart(await this.host.install(clone(target)))) return this._needsRestart(target.version);
      this._stage('activate');
      if (isRestart(await this.host.activate())) return this._needsRestart(target.version);
      this._stage('verify');
      if (await this.host.getActiveVersion() !== target.version) throw new UpdateError('activation_version_mismatch');
      this.currentVersion = target.version; this.currentManifest = this._candidateManifest;
      this.pendingVersion = null; this.blockedVersion = null;
      this._finishAttempt('updated');
      return this._set('updated');
    } catch (error) {
      this.blockedVersion = target.version;
      this.lastAttempt.failure = updateFailure(this.lastAttempt.stage, error);
      // The host checks the selected source again under its package-write lock.
      // A user may have switched to a development checkout after our backup;
      // when no package write began, restoring that backup would undo the user.
      if (error?.skipRollback === true && error?.code === 'update_source_changed') {
        this._finishAttempt('error');
        return this._set('error', 'installation_changed', 'update_source_changed');
      }
      if (error?.skipRollback === true && error?.code === 'update_install_not_started') {
        this._finishAttempt('error');
        return this._set('error', 'installation_unavailable', 'update_install_not_started');
      }
      if (!backedUp) { this._finishAttempt('error'); return this._set('error', null, 'backup_failed'); }
      try {
        this._stage('restore');
        const restored = await this.host.restore(snapshot);
        let needsRestart = isRestart(restored);
        if (!needsRestart) { this._stage('restore_activate'); needsRestart = isRestart(await this.host.activate()); }
        if (needsRestart) {
          this.rollbackPending = true;
          return this._needsRestart(oldVersion, 'rollback_restart_required');
        }
        this._stage('restore_verify');
        if (await this.host.getActiveVersion() !== oldVersion) throw new UpdateError('rollback_version_mismatch');
        this.currentVersion = oldVersion; this.currentManifest = oldManifest; this.pendingVersion = null;
        this._finishAttempt('rolled_back');
        return this._set('rolled_back', null, error instanceof UpdateError ? error.code : 'installation_failed');
      } catch (recoveryError) {
        this.lastAttempt.recoveryFailure = updateFailure(this.lastAttempt.stage, recoveryError);
        this._finishAttempt('recovery_required');
        return this._set('error', 'recovery_required', 'rollback_failed');
      }
    } finally { try { release(); } catch { /* The adapter owns lock release reliability. */ } }
  }
  _needsRestart(version, reason = 'restart_required') {
    this._finishAttempt('restart_required');
    this.pendingVersion = version; return this._set('restarting_needed', reason);
  }
}
