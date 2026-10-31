import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { UpdateManager } from './update-manager.js';
import { createHostUpdateAdapter, registerActiveVersion, scheduleOutsideProfileReload, updateProfileKey } from './update-host.js';
import { UpdateGate } from './update-gate.js';

const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')] ||= new Map();
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/** The coordinator outlives HMR disposal. It stores no persona, token or model data. */
export function setupUpdates(ctx, { stateFile, isBusy, runtime, createAdapter = createHostUpdateAdapter }) {
  const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : ctx.profileContext;
  const key = updateProfileKey(profile?.dir || dirname(stateFile));
  const updateFile = join(dirname(stateFile), 'plugin-update.json');
  let coordinator = shared.get(key);
  const acquire = () => {
    coordinator.runtime?.requestUpdatePause();
    const release = coordinator.gate.tryAcquireIdleLock();
    if (!release) return null;
    // This is a small continuation, not a snapshot of the companion. Tokens,
    // persona and model data stay in their existing files. Capture only after
    // the runtime has reached a boundary and the mutation gate is closed.
    coordinator.continuation = coordinator.runtime?.updateContinuation() || null;
    coordinator.resumeState = coordinator.continuation ? 'pending' : null;
    coordinator.persist(coordinator.manager.status());
    if (coordinator.storageError) {
      coordinator.continuation = null; coordinator.resumeState = null;
      release(); coordinator.runtime?.cancelUpdatePause(); return null;
    }
    return () => { release(); coordinator.afterUpdate?.(); };
  };
  if (!coordinator) {
    const gate = new UpdateGate();
    let adapter;
    try { adapter = createAdapter(ctx, { packageRoot, entryIds: [ctx.fiber?.entry?.id || 'tangui-registration'],
      tryAcquireIdleLock: acquire }); }
    catch { adapter = { mode: 'check-only', reason: 'host-unavailable', host: null }; }
    let initialState = {}, storageError = null;
    try {
      initialState = JSON.parse(readFileSync(updateFile, 'utf8'));
      if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) throw new Error('invalid_update_state');
    } catch (error) {
      if (error.code !== 'ENOENT') { initialState = { auto: false }; storageError = 'update_settings_invalid'; }
    }
    coordinator = { gate, adapter, storageError, continuation: initialState.continuation || null,
      resumeState: initialState.resumeState || null };
    coordinator.manager = new UpdateManager({ currentVersion: manifest.version, currentManifest: manifest,
      mode: adapter.mode, host: adapter.host, initialState, onChange: snapshot => coordinator.persist(snapshot) });
    shared.set(key, coordinator);
  }
  // Upgrade this writer too when inheriting a coordinator from older code.
  // Otherwise its old closure would silently omit new continuation fields.
  coordinator.persist = snapshot => {
    if (coordinator.storageError === 'update_settings_invalid') return;
    try {
      mkdirSync(dirname(updateFile), { recursive: true });
      const temporary = `${updateFile}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...snapshot, installation: coordinator.adapter.reason,
        continuation: coordinator.continuation || null, resumeState: coordinator.resumeState || null }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, updateFile);
      coordinator.storageError = null;
    } catch { coordinator.storageError = 'update_settings_save_failed'; }
  };
  const { gate } = coordinator;
  coordinator.runtime = runtime;
  const resolveAdapter = () => {
    try { return createAdapter(ctx, { packageRoot, entryIds: [ctx.fiber?.entry?.id || 'tangui-registration'],
      tryAcquireIdleLock: acquire }); }
    catch { return { mode: 'check-only', reason: 'host-unavailable', host: null }; }
  };
  let adapter = resolveAdapter();
  const generation = Symbol('loaded-update-code');
  coordinator.generation = generation;
  let disposed = false, applied = false, activeDisposer;
  const reconcile = () => {
    if (disposed || !applied || coordinator.generation !== generation || gate.locked || coordinator.manager._operation) return;
    const state = coordinator.manager.status();
    if (['waiting_idle', 'installing', 'restarting_needed'].includes(state.state) || state.reason === 'recovery_required') return;
    runtime?.cancelUpdatePause();
    if (!coordinator.continuation || coordinator.resumeState === 'failed') return;
    if (!['updated', 'rolled_back'].includes(state.state)) {
      // A pre-install failure leaves the same coroutine alive. A failed reload
      // must not revive an unverified/new identity or an unusable plugin.
      if (!runtime?.running()) return;
    }
    if (!runtime) { coordinator.resumeState = 'failed'; }
    else {
      try {
        if (!runtime.running()) runtime.resumeAfterUpdate(coordinator.continuation);
        coordinator.continuation = null; coordinator.resumeState = 'resumed';
      } catch { coordinator.resumeState = 'failed'; }
    }
    coordinator.persist(coordinator.manager.status());
  };
  const afterUpdate = () => {
    const operation = coordinator.manager._operation;
    if (operation) void operation.then(() => coordinator.reconcile?.(), () => coordinator.reconcile?.());
    else coordinator.reconcile?.();
  };
  coordinator.reconcile = reconcile; coordinator.afterUpdate = afterUpdate;
  if (runtime) runtime.onUpdateCancelled = () => {
    coordinator.continuation = null; coordinator.resumeState = null;
    coordinator.persist(coordinator.manager.status());
  };
  // Let the old installer finish its own recovery first, then transfer state to
  // the newly loaded updater implementation. Do not keep old updater code alive
  // for every subsequent release, or replace its host halfway through rollback.
  const adopt = () => {
    if (disposed || coordinator.generation !== generation) return;
    adapter = resolveAdapter();
    const previous = coordinator.manager.status();
    const replacement = new UpdateManager({ currentVersion: manifest.version, currentManifest: manifest,
      mode: adapter.mode, host: adapter.host, initialState: previous, onChange: coordinator.persist });
    if (!['installing', 'checking'].includes(previous.state) && !previous.pendingVersion) {
      replacement.state = previous.state; replacement.reason = previous.reason; replacement.error = previous.error;
      if (['development_check_only', 'host_check_only'].includes(previous.reason)) replacement.reason = replacement._checkOnlyReason();
    }
    coordinator.manager = replacement; coordinator.adapter = adapter;
    reconcile();
  };
  if (coordinator.manager._operation) void coordinator.manager._operation.then(adopt, adopt);
  else adopt();
  const unregister = gate.register(isBusy);
  // DSH activates services by availability, not by rows in its plugin list.
  // The optional HMR service can still be starting during our apply(). Retry
  // capability detection once it is available instead of caching that moment
  // forever. Never replace the host owning an in-flight install or rollback.
  const refreshHost = () => {
    if (disposed || coordinator.generation !== generation || coordinator.manager._operation || gate.locked) return;
    adapter = resolveAdapter();
    const changed = coordinator.adapter.mode !== adapter.mode || coordinator.adapter.reason !== adapter.reason;
    coordinator.adapter = adapter;
    coordinator.manager.mode = adapter.mode; coordinator.manager.host = adapter.host;
    if (['development_check_only', 'host_check_only'].includes(coordinator.manager.reason)) {
      coordinator.manager.reason = coordinator.manager._checkOnlyReason();
    }
    if (applied && !activeDisposer && adapter.profileDir) activeDisposer = registerActiveVersion(manifest.version, { profileDir: adapter.profileDir });
    if (changed) coordinator.persist(coordinator.manager.status());
  };
  // Call after this apply has successfully registered the plugin's routes/tools.
  const ready = () => {
    applied = true; refreshHost();
    if (!activeDisposer && adapter.profileDir) activeDisposer = registerActiveVersion(manifest.version, { profileDir: adapter.profileDir });
    coordinator.manager.currentManifest = manifest;
    coordinator.manager.setCurrentVersion(manifest.version);
    afterUpdate();
  };
  const status = () => ({ ...coordinator.manager.status(), installation: coordinator.adapter.reason, storageError: coordinator.storageError,
    resumeState: coordinator.resumeState || null,
    manualInstall: true, canInstall: !coordinator.storageError && coordinator.manager.canInstall?.() === true });
  const check = () => { refreshHost(); void coordinator.manager.check({ install: false, manual: true }).then(afterUpdate, afterUpdate); return status(); };
  const install = target => {
    refreshHost();
    if (coordinator.storageError) throw Object.assign(new Error('update_settings_invalid'), { code: 'update_settings_invalid' });
    if (typeof coordinator.manager.install !== 'function') throw Object.assign(new Error('update_busy'), { code: 'update_busy' });
    void coordinator.manager.install(target).then(afterUpdate, afterUpdate);
    return status();
  };
  const setAuto = value => {
    if (typeof value !== 'boolean') throw new Error('invalid_update_setting');
    if (coordinator.storageError === 'update_settings_invalid') throw new Error('update_settings_invalid');
    coordinator.manager.setAuto(value); afterUpdate(); return status();
  };
  const hold = (clientId, editing) => { gate.hold(clientId, editing); return status(); };
  // Startup obeys the same hourly interval and Beijing quiet hours as later
  // ticks. Installation gets a separate tick and still requires an idle gate.
  const tick = install => { refreshHost(); void coordinator.manager.tick({ install }).then(afterUpdate, afterUpdate); };
  const { first, interval } = scheduleOutsideProfileReload(ctx, () => {
    const first = setTimeout(() => { tick(false); }, 2000);
    first.unref?.();
    const interval = setInterval(() => { tick(coordinator.manager.auto); }, 15000);
    interval.unref?.();
    return { first, interval };
  });
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(first); clearInterval(interval); unregister(); activeDisposer?.();
    // Never await the installer here: HMR is itself waiting for disposal.
  }, 'tangui: update checks');
  return { status, check, install, setAuto, hold, ready, gate };
}
