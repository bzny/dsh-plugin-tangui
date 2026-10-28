// A synchronous gate closes the gap between the last idle check and starting
// a package update. This only coordinates this plugin's operations.
export class UpdateGate {
  constructor() { this.locked = false; this.operations = 0; this.readers = new Map(); this.editors = new Map(); }
  register(isBusy) {
    const key = Symbol('plugin-instance'); this.readers.set(key, isBusy);
    return () => this.readers.delete(key);
  }
  hold(clientId, editing, now = Date.now()) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(clientId) || typeof editing !== 'boolean') throw new Error('invalid_update_hold');
    if (editing && this.locked) { const error = new Error('插件正在更新，请稍后编辑。'); error.code = 'plugin_updating'; error.status = 409; throw error; }
    if (editing) this.editors.set(clientId, now + 30000); else this.editors.delete(clientId);
  }
  busy() {
    for (const [id, expires] of this.editors) if (expires <= Date.now()) this.editors.delete(id);
    if (this.operations || this.editors.size || !this.readers.size) return true;
    try { return [...this.readers.values()].some(read => read()); } catch { return true; }
  }
  tryAcquireIdleLock() {
    if (this.locked || this.busy()) return null;
    this.locked = true;
    let released = false;
    return () => { if (!released) { released = true; this.locked = false; } };
  }
  enter() {
    if (this.locked) {
      const error = new Error('插件正在更新，请等待完成后再操作。');
      error.code = 'plugin_updating'; error.status = 409; throw error;
    }
    this.operations += 1;
    let released = false;
    return () => { if (!released) { released = true; this.operations -= 1; } };
  }
  async run(work, readOnly = false) {
    if (readOnly) return work();
    const release = this.enter();
    try { return await work(); } finally { release(); }
  }
}

