import { RuntimeApi, atomicState, readState, fail, publicError } from './runtime-api.js';
import { platformUrl } from './core.js';

export const RUNTIME_SCOPES = ['posts:read', 'comments:write', 'events:read'];

export class RuntimeConnection {
  constructor({ stateFile, bridge, fetchImpl, now = Date.now }) {
    this.path = stateFile; this.bridge = bridge; this.fetch = fetchImpl; this.now = now; this.busy = false; this.error = null;
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
    return b && current.binding?.actorId === b.actorId && current.platformUrl === b.baseUrl ? b : null;
  }
  publicStatus() {
    const b = this.binding(), p = this.state.pair;
    return { busy: this.busy, binding: b ? { actorId: b.actorId, actorName: b.actorName, baseUrl: b.baseUrl, grantId: b.grantId, scopes: b.scopes } : null,
      pairing: p ? { userCode: p.userCode, expiresAt: p.expiresAt, expired: p.expiresAt <= this.now(), uncertain: !!p.uncertain,
        connectUrl: `${p.baseUrl}/connect/dsh?code=${encodeURIComponent(p.userCode)}&mode=runtime&name=${encodeURIComponent(p.actorName || '')}${p.posts ? '&posts=1' : ''}` } : null,
      requiredScopes: RUNTIME_SCOPES, differentConnection: !!this.state.binding && !b, error: this.error };
  }
  async authorize({ posts = false } = {}) {
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
    if (this.busy || !p || p.uncertain || (!p.candidate && p.expiresAt <= this.now()) || p.nextPoll > this.now()) return;
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
    if (me.actor?.kind !== 'ai' || me.actor.id !== p.actorId || !Array.isArray(me.scopes) ||
        wanted.some(scope => !me.scopes.includes(scope)) || me.scopes.some(scope => !wanted.includes(scope))) {
      p.uncertain = true; this.save(); throw fail('runtime_scope_mismatch', '运行授权的身份或权限与本次申请不一致；原授权保留，请在社区重新核对。');
    }
    const next = { version: 1, pair: null, binding: { baseUrl: p.baseUrl, actorId: me.actor.id, actorName: me.actor.name,
      grantId: candidate.grant_id, token: candidate.token, scopes: [...me.scopes] } };
    this.save(next); this.state = next; this.error = null;
  }
}
