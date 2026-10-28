import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError } from './core.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const error = (code, message, status = 400) => new BridgeError(`management_session_${code}`, message, status);

// A header-only observation is enough. Do not resume an Agent, load its chat,
// create a Session, or write notices into the model-visible conversation.
export async function validateManagementSession(ctx, sessionId) {
  if (!validId(sessionId)) throw error('invalid', '请选择有效的 DSH 会话。');
  const archived = () => ctx.get?.('workspaceRegistry')?.archivedSessionIds?.includes(sessionId);
  if (archived()) throw error('archived', '这个 DSH 会话已归档，请选择当前仍在使用的会话。', 409);
  let header;
  try {
    header = ctx.get?.('sessions')?.get(sessionId)?.header;
    if (!header) {
      const persistence = ctx.get?.('sessionPersistence');
      if (typeof persistence?.stat !== 'function') throw error('unavailable', 'DSH 会话信息暂不可用，请稍后重试。', 503);
      header = (await persistence.stat(sessionId))?.header;
    }
  } catch (cause) {
    if (cause instanceof BridgeError) throw cause;
    throw error('unavailable', '暂时无法确认这个 DSH 会话，请稍后重试。', 503);
  }
  if (!header || header.id !== sessionId) throw error('not_found', '这个 DSH 会话不存在，请选择当前仍在使用的会话。', 404);
  if (header.origin === 'subagent') throw error('invalid', '请选择你直接使用的 DSH 会话，而不是内部子任务。');
  if (archived()) throw error('archived', '这个 DSH 会话已归档，请选择当前仍在使用的会话。', 409);
  return sessionId;
}

function atomicSave(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temporary, file);
    created = false;
  } finally {
    // Only this invocation's newly created temporary file may be removed.
    if (created) { try { unlinkSync(temporary); } catch {} }
  }
}

export class ManagementSession {
  constructor({ file, validate, save = atomicSave }) {
    this.file = file;
    this.validate = validate;
    this.save = save;
    this.sessionId = null;
    this.storageError = false;
    this.invalidStoredState = false;
    this.pending = Promise.resolve();
    try {
      if (existsSync(file)) {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 4096) throw new Error('invalid management state');
        const stored = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (!stored || Object.keys(stored).length !== 1 || !validId(stored.sessionId)) throw new Error('invalid management state');
        this.sessionId = stored.sessionId;
      }
    } catch {
      // Preserve an unreadable existing file, including on automatic capture.
      this.storageError = this.invalidStoredState = true;
    }
  }

  publicStatus() {
    return { sessionId: this.sessionId, ...(this.storageError ? { storageError: true } : {}) };
  }

  bind(sessionId, { automatic = false } = {}) {
    const task = this.pending.then(async () => {
      // Even a deleted/archived target is not silently replaced by another chat.
      if (automatic && this.sessionId) return this.publicStatus();
      if (this.invalidStoredState) throw error('save_failed', '管理会话设置文件无法读取，已保留原文件；社区操作不受影响。', 503);
      const accepted = await this.validate(sessionId);
      if (accepted !== sessionId) throw error('invalid', '请选择有效的 DSH 会话。');
      if (sessionId === this.sessionId && !this.storageError) return this.publicStatus();
      try { this.save(this.file, { sessionId }); }
      catch {
        this.storageError = true;
        throw error('save_failed', '管理会话设置未能保存，原设置保留；社区操作不受影响。', 503);
      }
      this.sessionId = sessionId;
      this.storageError = false;
      return this.publicStatus();
    });
    this.pending = task.catch(() => {});
    return task;
  }

  async capture(exec) {
    const sessionId = exec?.agent?.session?.id;
    if (!sessionId || this.sessionId) return;
    try { await this.bind(sessionId, { automatic: true }); }
    catch { /* Notification setup must never turn successful work into failure. */ }
  }
}

export async function captureManagementSession(management, exec) {
  try { await management?.capture(exec); }
  catch { /* Also contain optional host integration failures. */ }
}
