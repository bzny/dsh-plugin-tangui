import { RuntimeApi, atomicState, readState, fail, publicError } from './runtime-api.js';
import { platformUrl } from './core.js';

export const RUNTIME_SCOPES = ['posts:read', 'comments:write', 'events:read'];
const sameBinding = (a, b) => !!a && !!b && ['baseUrl', 'actorId', 'grantId', 'token'].every(key => a[key] === b[key]);

export function publicActorName(actor, expectedId) {
  if (actor?.id !== expectedId || actor.kind !== 'ai' || typeof actor.name !== 'string' || !actor.name.trim() || actor.name.length > 100) {
    throw fail('runtime_identity_mismatch', '社区返回的公开身份与当前伙伴不一致；保留原显示名称。');
  }
  return actor.name;
}

export class RuntimeConnection {
  constructor({ stateFile, bridge, fetchImpl, now = Date.now }) {
    this.path = stateFile; this.bridge = bridge; this.fetch = fetchImpl; this.now = now; this.busy = false; this.error = null;
    this.identityRefresh = { status: 'unknown', checkedAt: null }; this.identityRead = null; this.identityCache = null; this.identityVersion = 0;
    this.state = readState(stateFile) || { version: 1, binding: null, pair: null };
    if (this.state.version !== 1) throw fail('runtime_state_invalid', '运行授权状态版本无效；原文件保留。');
    if (this.state.binding) {
      const b = this.state.binding;
      if (![b.token, b.actorId, b.grantId].every(x => typeof x === 'string' && x) || !Array.isArray(b.scopes) || b.scopes.some(x => typeof x !== 'string')) throw fail('runtime_state_invalid', '运行授权资料不完整；原文件保留。');
      b.baseUrl = platformUrl(b.baseUrl);
    }
    if (this.state.pair) {
      const p = this.state.pair;
      if (![p.actorId, p.deviceCode, p.userCode].every(x => typeof x === 'string' && x) || !Number.isFinite(p.expiresAt) || !Number.isFinite(p.nextPoll) || typeof p.posts !== 'boolean') throw fail('runtime_state_invalid', '运行配对资料不完整；原文件保留。');
      p.baseUrl = platformUrl(p.baseUrl);
    }
    if (this.state.pair?.redeeming) {
      this.state.pair.uncertain = true;
      this.error = { code: 'authorization_result_unknown', message: '上次授权领取结果未确认；请在社区检查并撤销该次旧授权，再明确重新申请。' };
    }
  }
  save(next = this.state) { atomicState(this.path, next); }
  binding() {
    const b = this.state.binding, current = this.bridge.publicStatus();
    if (b && current.binding?.actorId === b.actorId && current.platformUrl === b.baseUrl) return b;
    const original = this.bridge.state?.binding;
    return original?.token && current.binding?.actorId === original.actorId ? { ...original, baseUrl: current.platformUrl, scopes: original.scopes || ['persona:write'] } : null;
  }
  publicStatus() {
    const b = this.binding(), p = this.state.pair;
    return { busy: this.busy, binding: b ? { actorId: b.actorId, actorName: b.actorName, baseUrl: b.baseUrl, grantId: b.grantId, scopes: b.scopes } : null,
      pairing: p ? { userCode: p.userCode, expiresAt: p.expiresAt, expired: p.expiresAt <= this.now(), uncertain: !!p.uncertain,
        connectUrl: `${p.baseUrl}/connect/dsh?code=${encodeURIComponent(p.userCode)}&mode=runtime&name=${encodeURIComponent(p.actorName || '')}${p.posts ? '&posts=1' : ''}` } : null,
      requiredScopes: RUNTIME_SCOPES, differentConnection: !!this.state.binding && !b, error: this.error,
      identityRefresh: sameBinding(this.identityCache?.binding, b) ? { ...this.identityRefresh } : { status: 'unknown', checkedAt: null } };
  }
  observeActor(actor, expected) {
    // Nicknames are public metadata. Never replace identity, authorization,
    // persona, memory, cursors or an in-progress pairing to refresh a label.
    const current = this.binding();
    if (!sameBinding(current, expected)) return false;
    const name = publicActorName(actor, current.actorId);
    const original = this.bridge.state?.binding;
    if (original?.actorId === current.actorId && this.bridge.state.baseUrl === current.baseUrl) original.actorName = name;
    if (sameBinding(this.state.binding, current)) this.state.binding.actorName = name;
    this.identityRefresh = { status: 'synced', checkedAt: this.now() };
    this.identityCache = { binding: { ...current }, actor: { ...actor }, at: this.now() };
    this.identityVersion++;
    return true;
  }
  async refreshIdentity() {
    const binding = this.binding();
    if (!binding || this.busy || this.bridge.busy) return null;
    if (this.identityRead) return this.identityRead;
    if (this.identityCache && sameBinding(this.identityCache.binding, binding) && this.now() - this.identityCache.at < 30000) {
      return this.identityRefresh.status === 'synced' ? this.identityCache.actor : null;
    }
    const snapshot = { ...binding };
    const version = this.identityVersion;
    this.identityRead = (async () => {
      try {
        const me = await new RuntimeApi({ baseUrl: snapshot.baseUrl, token: snapshot.token, fetchImpl: this.fetch, timeoutMs: 5000 }).data('/api/v1/me');
        if (!sameBinding(this.binding(), snapshot)) return null;
        if (version !== this.identityVersion) return this.identityCache?.actor || null;
        if (this.observeActor(me?.actor, snapshot)) return { ...me.actor };
      } catch {
        // A display refresh is never permission to reconnect, restart or retry
        // a model. Preserve the last label, but do not claim a fresh success.
        if (sameBinding(this.binding(), snapshot) && version === this.identityVersion) {
          this.identityRefresh = { status: 'unconfirmed', checkedAt: this.identityRefresh.checkedAt };
          this.identityCache = { binding: snapshot, actor: null, at: this.now() };
        }
      }
      return null;
    })().finally(() => { this.identityRead = null; });
    return this.identityRead;
  }
  async authorize({ posts = false } = {}) {
    if (this.binding()) { this.error = null; return this.publicStatus(); }
    if (this.busy) throw fail('runtime_authorization_busy', '正在处理运行授权，请稍候。');
    const existing = this.bridge.publicStatus();
    if (!existing.binding?.actorId) throw fail('persona_binding_required', '请先注册或绑定伙伴并同步人设，再申请社区运行授权。');
    if (typeof posts !== 'boolean') throw fail('invalid_request', '发帖权限选项须为布尔值。');
    this.busy = true; this.error = null;
    try {
      const api = new RuntimeApi({ baseUrl: existing.platformUrl, fetchImpl: this.fetch });
      const result = await api.data('/api/v1/pairings', { body: { label: posts ? 'DSH 社区运行（含主动发帖）' : 'DSH 社区运行' } });
      if (typeof result.device_code !== 'string' || !result.device_code || typeof result.user_code !== 'string' || !result.user_code || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw fail('invalid_pairing_response', '运行配对响应不完整；未替换原授权。');
      const next = { ...this.state, pair: { baseUrl: existing.platformUrl, actorId: existing.binding.actorId,
        actorName: existing.binding.actorName || existing.draft?.name || '', posts, deviceCode: result.device_code, userCode: result.user_code,
        expiresAt: this.now() + Math.min(600, Number(result.expires_in)) * 1000,
        nextPoll: this.now() + Math.max(5, Number(result.interval) || 5) * 1000 } };
      this.save(next); this.state = next;
      return this.publicStatus();
    } catch (error) { this.error = publicError(error); throw error; }
    finally { this.busy = false; }
  }
  async tick() {
    const p = this.state.pair;
    // A persisted candidate can be checked again without redeeming its one-shot
    // token. This also recovers old exact-scope checks after a server upgrade.
    if (this.busy || !p || (p.uncertain && !p.candidate) || (!p.candidate && p.expiresAt <= this.now()) || p.nextPoll > this.now()) return;
    const current = this.bridge.publicStatus();
    if (current.binding?.actorId !== p.actorId || current.platformUrl !== p.baseUrl) return;
    this.busy = true;
    try {
      if (p.candidate) { p.nextPoll = this.now() + 5000; await this.validateCandidate(); return; }
      p.redeeming = true; this.save();
      const api = new RuntimeApi({ baseUrl: p.baseUrl, fetchImpl: this.fetch });
      let result;
      try { result = await api.data('/api/v1/pairings/token', { body: { device_code: p.deviceCode } }); }
      catch (error) {
        if (error.code === 'authorization_pending') { p.redeeming = false; p.nextPoll = this.now() + 5000; this.save(); return; }
        p.uncertain = true; this.save(); throw fail('authorization_result_unknown', '运行授权领取结果未确认；旧授权保留。请在社区核对并撤销本次授权后，明确重新申请。');
      }
      if (typeof result.token !== 'string' || !result.token || result.actor_id !== p.actorId || !result.grant_id) {
        p.uncertain = true; this.save(); throw fail('runtime_identity_mismatch', '批准的 AI 与当前伙伴不一致；原运行授权保留，请在社区撤销这次错误授权。');
      }
      // Keep the redeemed candidate locally before another network call; a
      // network failure must not lose the one-shot credential or replace a
      // known-working binding. It is never returned in publicStatus().
      p.candidate = result; p.redeeming = false; this.save();
      await this.validateCandidate();
    } catch (error) { this.error = publicError(error); }
    finally { this.busy = false; }
  }
  async validateCandidate() {
    const p = this.state.pair;
    if (!p?.candidate) return;
    const candidate = p.candidate;
    const me = await new RuntimeApi({ baseUrl: p.baseUrl, token: candidate.token, fetchImpl: this.fetch }).data('/api/v1/me');
    const wanted = [...RUNTIME_SCOPES, ...(p.posts ? ['posts:write'] : [])];
    const actual = Object.hasOwn(me, 'effective_scopes') ? me.effective_scopes : me.scopes;
    if (me.actor?.kind !== 'ai' || me.actor.id !== p.actorId || candidate.actor_id !== p.actorId ||
        !Array.isArray(actual) || actual.some(scope => typeof scope !== 'string') || actual.includes('manage') ||
        (Array.isArray(me.scopes) && me.scopes.includes('manage')) || wanted.some(scope => !actual.includes(scope))) {
      p.uncertain = true; this.save(); throw fail('runtime_scope_mismatch', '运行授权的身份或权限与本次申请不一致；原授权保留，请在社区重新核对。');
    }
    const next = { version: 1, pair: null, binding: { baseUrl: p.baseUrl, actorId: me.actor.id, actorName: me.actor.name,
      grantId: candidate.grant_id, token: candidate.token, scopes: [...actual] } };
    this.save(next); this.state = next; this.error = null;
  }
}
