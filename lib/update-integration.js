import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { UpdateManager } from './update-manager.js';
import { createHostUpdateAdapter, registerActiveVersion, updateProfileKey } from './update-host.js';
import { UpdateGate } from './update-gate.js';

const shared = globalThis[Symbol.for('dsh-plugin-tangui.update-coordinators.v1')] ||= new Map();
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/** The coordinator outlives HMR disposal. It stores no persona, token or model data. */
export function setupUpdates(ctx, { stateFile, isBusy }) {
  const profile = ctx.get?.('profileContext') || ctx.profileContext;
  const key = updateProfileKey(profile?.dir || dirname(stateFile));
  let coordinator = shared.get(key);
  if (!coordinator) {
    const gate = new UpdateGate();
    let adapter;
    try { adapter = createHostUpdateAdapter(ctx, { packageRoot, entryIds: [ctx.fiber?.entry?.id || 'tangui-registration'],
      tryAcquireIdleLock: () => gate.tryAcquireIdleLock() }); }
    catch { adapter = { mode: 'development', reason: 'host-unavailable', host: null }; }
    const updateFile = join(dirname(stateFile), 'plugin-update.json');
    let initialState = {}, storageError = null;
    try {
      initialState = JSON.parse(readFileSync(updateFile, 'utf8'));
      if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) throw new Error('invalid_update_state');
    } catch (error) {
      if (error.code !== 'ENOENT') { initialState = { auto: false }; storageError = 'update_settings_invalid'; }
    }
    coordinator = { gate, adapter, storageError };
    const persist = snapshot => {
      if (coordinator.storageError === 'update_settings_invalid') return;
      try {
        mkdirSync(dirname(updateFile), { recursive: true });
        const temporary = `${updateFile}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, updateFile);
        coordinator.storageError = null;
      } catch { coordinator.storageError = 'update_settings_save_failed'; }
    };
    coordinator.persist = persist;
    coordinator.manager = new UpdateManager({ currentVersion: manifest.version, currentManifest: manifest,
      mode: adapter.mode, host: adapter.host, initialState, onChange: persist });
    shared.set(key, coordinator);
  }
  const { gate } = coordinator;
  let adapter;
  try { adapter = createHostUpdateAdapter(ctx, { packageRoot, entryIds: [ctx.fiber?.entry?.id || 'tangui-registration'],
    tryAcquireIdleLock: () => gate.tryAcquireIdleLock() }); }
  catch { adapter = { mode: 'development', reason: 'host-unavailable', host: null }; }
  const generation = Symbol('loaded-update-code');
  coordinator.generation = generation;
  let disposed = false;
  // Let the old installer finish its own recovery first, then transfer state to
  // the newly loaded updater implementation. Do not keep old updater code alive
  // for every subsequent release, or replace its host halfway through rollback.
  const adopt = () => {
    if (disposed || coordinator.generation !== generation) return;
    const previous = coordinator.manager.status();
    const replacement = new UpdateManager({ currentVersion: manifest.version, currentManifest: manifest,
      mode: adapter.mode, host: adapter.host, initialState: previous, onChange: coordinator.persist });
    if (!['installing', 'checking'].includes(previous.state) && !previous.pendingVersion) {
      replacement.state = previous.state; replacement.reason = previous.reason; replacement.error = previous.error;
    }
    coordinator.manager = replacement; coordinator.adapter = adapter;
  };
  if (coordinator.manager._operation) void coordinator.manager._operation.then(adopt, adopt);
  else adopt();
  const unregister = gate.register(isBusy);
  let activeDisposer;
  // Call after this apply has successfully registered the plugin's routes/tools.
  const ready = () => {
    if (adapter.profileDir) activeDisposer = registerActiveVersion(manifest.version, { profileDir: adapter.profileDir });
    coordinator.manager.currentManifest = manifest;
    coordinator.manager.setCurrentVersion(manifest.version);
  };
  const status = () => ({ ...coordinator.manager.status(), installation: coordinator.adapter.reason, storageError: coordinator.storageError,
    manualInstall: true, canInstall: !coordinator.storageError && coordinator.manager.canInstall?.() === true });
  const check = () => { void coordinator.manager.check({ install: false, manual: true }).catch(() => {}); return status(); };
  const install = target => {
    if (coordinator.storageError) throw Object.assign(new Error('update_settings_invalid'), { code: 'update_settings_invalid' });
    if (typeof coordinator.manager.install !== 'function') throw Object.assign(new Error('update_busy'), { code: 'update_busy' });
    void coordinator.manager.install(target).catch(() => {});
    return status();
  };
  const setAuto = value => {
    if (typeof value !== 'boolean') throw new Error('invalid_update_setting');
    if (coordinator.storageError === 'update_settings_invalid') throw new Error('update_settings_invalid');
    coordinator.manager.setAuto(value); return status();
  };
  const hold = (clientId, editing) => { gate.hold(clientId, editing); return status(); };
  // Checking starts promptly. Installation gets a separate tick, and can only
  // start when the gate has observed no active operation or unsaved UI edits.
  const first = setTimeout(() => { void coordinator.manager.check({ install: false }).catch(() => {}); }, 2000);
  first.unref?.();
  const interval = setInterval(() => { void coordinator.manager.tick().catch(() => {}); }, 15000);
  interval.unref?.();
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(first); clearInterval(interval); unregister(); activeDisposer?.();
    // Never await the installer here: HMR is itself waiting for disposal.
  }, 'tangui: update checks');
  return { status, check, install, setAuto, hold, ready, gate };
}
