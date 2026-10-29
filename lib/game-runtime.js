import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError, platformUrl } from './core.js';
import { safeModelCallId } from './model-call-log.js';

export const GAME_PROTOCOL = 'carbon-silicon.turn-game.v1';
const FINISHED = new Set(['finished', 'completed', 'ended', 'aborted', 'interrupted', 'error']);
const CONTROL_ERRORS = new Set(['unauthorized', 'scope_denied', 'control_lost', 'control_busy', 'account_unavailable']);
const MODEL_REQUEST_STATUSES = new Set(['model_started', 'model_failed', 'pending', 'accepted', 'rejected', 'discarded_late']);
const DISCARD_REASONS = new Set(['stopped', 'expired', 'state_changed']);
const copy = (value) => JSON.parse(JSON.stringify(value));
const resource = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new BridgeError('invalid_game_id', '游戏资源编号无效。');
  return value;
};
const instant = (value) => {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new BridgeError('invalid_game_time', '游戏平台时间无效。');
  return Date.parse(value);
};
const errorCode = (error) => error instanceof BridgeError ? error.code : 'game_operation_failed';
const supportsRulesVersion = (manifest, rulesVersion) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const variants = Object.hasOwn(manifest, 'rules_versions') ? manifest.rules_versions : [];
  if (typeof manifest.rules_version !== 'string' || !manifest.rules_version.trim() ||
    !Array.isArray(variants) || variants.some(value => typeof value !== 'string' || !value.trim())) return false;
  return manifest.rules_version === rulesVersion || variants.includes(rulesVersion);
};

/** One host controller. No reads of local memory and no model call on import. */
export class GameRuntime {
  constructor({ bridge, stateFile, decide, fetchImpl = fetch, now = Date.now,
    monotonic = () => performance.now(), pollMs = 500, automatic = true, requestTimeoutMs = 5000 }) {
    this.bridge = bridge; this.stateFile = stateFile; this.decide = decide; this.fetch = fetchImpl;
    this.now = now; this.monotonic = monotonic; this.pollMs = Math.max(50, pollMs);
    this.automatic = automatic; this.requestTimeoutMs = requestTimeoutMs;
    this.state = { version: 1, identity: null, binding: null, pairing: null, journals: {}, status: 'stopped', enabled: false };
    if (existsSync(stateFile)) {
      let saved;
      try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { throw new BridgeError('game_state_invalid', '游戏进度文件无法读取，未覆盖。'); }
      if (saved.version !== 1 || !saved.journals || typeof saved.journals !== 'object' || Array.isArray(saved.journals)) throw new BridgeError('game_state_invalid', '游戏进度格式无效，未覆盖。');
      this.state = { ...this.state, ...saved, enabled: false, status: 'stopped' };
      if (this.state.pairing?.redeeming) this.state.status = 'pairing_result_unknown';
    }
    this.busy = false; this.stepping = false; this.lease = null; this.active = null; this.timer = null;
    this.abort = null; this.lastSeq = -1; this.deadlines = new Map(); this.persona = {};
    this.expectedGame = null; this.preparedLease = null; this.selectedRoom = null;
    this.stoppedRooms = new Set();
    this.participationPaused = false;
    this.legacyBinding = this.state.binding;
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.unifiedBinding ? { ...this.state, binding: this.legacyBinding } : this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  status() {
    const journal = this.state.journals[this.state.roomId];
    const requestId = journal?.lastModelRequestId;
    const record = typeof requestId === 'string' ? journal.requests?.[requestId] : null;
    const callId = safeModelCallId(record?.call_id);
    return { status: this.state.status, running: this.busy, enabled: this.state.enabled,
      platformUrl: this.state.identity?.baseUrl || '', actorId: this.state.identity?.actorId || null,
      roomId: this.state.roomId || null, modelCalls: journal?.modelCalls || 0,
      maxModelCalls: this.state.maxModelCalls || 300, error: this.state.error || null,
      binding: this.state.binding ? { actorId: this.state.binding.actorId, grantId: this.state.binding.grantId } : null,
      pairing: this.state.pairing ? { userCode: this.state.pairing.userCode,
        approvalUrl: `${this.state.identity.baseUrl}/manage#pairing-form`,
        requiredScope: 'games:play', expiresAt: this.state.pairing.expiresAt } : null,
      pendingInvitations: copy(this.state.pendingInvitations || []),
      result: journal?.result || null,
      last_model_call: callId ? { call_id: callId, request_id: requestId,
        status: MODEL_REQUEST_STATUSES.has(record.status) ? record.status : null,
        reason: DISCARD_REASONS.has(record.reason) ? record.reason : null } : null,
      personaSource: 'community_actor_configuration',
      guidance: '小游戏与社区共用一个伙伴连接和控制会话。处理已接受的邀请，或按网站自动接受偏好入桌；游戏期间暂停社区和日记，结束后恢复。人设来自当前 AI 的社区配置，不读取全部本机长期记忆。' };
  }

  async request(path, { body, token, headers = {}, signal, controlled = false } = {}) {
    if (controlled) { this.ensureControl(); headers = { ...headers, ...this.controlHeaders() }; }
    const origin = platformUrl(this.state.identity.baseUrl);
    if (typeof path !== 'string' || !path.startsWith('/api/v1/') || path.includes('..') || path.includes('#')) throw new BridgeError('invalid_endpoint', '游戏接口路径无效。');
    let response;
    try {
      response = await this.fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs) });
    } catch {
      const error = new BridgeError('network_error', '游戏连接中断或请求超时，未猜测服务端结果。', 503);
      error.community_transport = true; throw error;
    }
    const gateway = [502, 503, 504].includes(response.status);
    const interrupted = () => {
      const error = new BridgeError('network_error', '游戏连接中断或请求超时，未猜测服务端结果。', 503);
      error.community_transport = true; return error;
    };
    let value;
    try { value = await response.json(); } catch (error) {
      if (signal?.aborted) throw new BridgeError('game_stopped', '游戏操作已取消。');
      if (gateway || error?.name !== 'SyntaxError') throw interrupted();
      throw new BridgeError('invalid_game_response', '游戏平台返回格式无效。', 502);
    }
    if (signal?.aborted) throw new BridgeError('game_stopped', '游戏操作已取消。');
    if (!response.ok) {
      if (gateway && !value?.error?.code) throw interrupted();
      const reported = value?.error?.code;
      const code = typeof reported === 'string' && /^[a-z][a-z0-9_]{0,70}$/.test(reported) ? reported : 'game_platform_error';
      throw new BridgeError(code, `游戏平台拒绝操作（${response.status}，${code}）。`, response.status);
    }
    if (!value || !Object.hasOwn(value, 'data')) throw new BridgeError('invalid_game_response', '游戏平台缺少data响应。', 502);
    return value.data;
  }

  api(path, body, key) {
    return this.request('/api/v1' + path, { body, token: this.state.binding.token,
      headers: key ? { 'Idempotency-Key': key } : {}, controlled: true, signal: this.abort?.signal });
  }

  controlIdentity() {
    this.ensureControl();
    return { grantId: this.state.binding.grantId, instanceId: this.sessionOwner?.instanceId || this.bridge.state.instanceId, epoch: this.sessionOwner?.lease.epoch || this.lease.epoch };
  }

  controlHeaders() {
    if (this.sessionOwner) return this.sessionOwner.proof();
    return { 'X-AI-Instance-ID': this.bridge.state.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) };
  }

  ensureControl() {
    if (this.sessionOwner) { this.sessionOwner.checkActive(); this.lease = this.sessionOwner.lease; return; }
    if (!this.busy || !this.state.enabled || !this.lease || this.monotonic() >= this.lease.deadline || this.abort?.signal.aborted) {
      throw new BridgeError('control_lost', '游戏控制权已停止或到期。', 409);
    }
  }

  validateLease(value, started, acquiring) {
    if (!this.busy || !this.state.enabled || this.abort?.signal.aborted) throw new BridgeError('control_lost', '游戏控制端已停止。', 409);
    if (!value?.active || !value.owned_by_current_grant || value.actor_id !== this.state.identity.actorId ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 1 || (!acquiring && value.epoch !== this.lease?.epoch)) throw new BridgeError('control_lost', '游戏平台未确认当前控制权。', 409);
    const remaining = Math.min(60000, instant(value.expires_at) - instant(value.server_time));
    const deadline = started + remaining;
    if (remaining <= 0 || this.monotonic() >= deadline || (!acquiring && this.monotonic() >= this.lease.deadline)) throw new BridgeError('control_lost', '游戏控制权已经过期。', 409);
    const delay = value.renew_after_seconds ?? 15;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0 || delay > 15) throw new BridgeError('invalid_control_response', '控制权续期间隔无效。');
    this.lease = { epoch: value.epoch, deadline, renewAt: this.monotonic() + Math.min(delay * 1000, (deadline - this.monotonic()) / 2) };
  }

  async start({ maxModelCalls, roomId = null, signal } = {}) {
    if (this.busy || this.stepping) throw new BridgeError('game_already_running', '游戏控制端已在运行或正在停止。', 409);
    if (this.bridge.busy) throw new BridgeError('busy', '人设同步正在进行，请完成后启动游戏。', 409);
    signal?.throwIfAborted();
    maxModelCalls = maxModelCalls ?? this.state.maxModelCalls ?? 300;
    if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 10000) throw new BridgeError('invalid_game_budget', '模型调用预算须为1至10000。');
    const source = this.bridge.state;
    if (source.pending || this.bridge.resumeImport) throw new BridgeError('persona_sync_pending', '请先确认原人设同步结果，再启动游戏。');
    if (!source.binding?.actorId || !source.baseUrl) throw new BridgeError('not_bound', '请先连接已有DSH伙伴的社区AI身份。');
    const identity = { baseUrl: platformUrl(source.baseUrl), actorId: source.binding.actorId };
    if (this.state.identity && JSON.stringify(this.state.identity) !== JSON.stringify(identity)) throw new BridgeError('game_connection_changed', '游戏授权属于其他社区或AI，未替换原授权。');
    this.state.identity = identity; this.state.maxModelCalls = maxModelCalls; this.state.enabled = true;
    this.state.error = null; this.state.status = 'starting'; this.busy = true;
    this.selectedRoom = roomId ? resource(roomId) : null;
    this.abort = new AbortController(); this.lastSeq = -1; this.expectedGame = null; this.preparedLease = null;
    this.save();
    try {
      await this.step();
      if (this.automatic && this.busy) {
        this.timer = setInterval(() => { void this.step(); }, this.pollMs);
        this.timer.unref?.();
      }
    } catch (error) { await this.stop(errorCode(error)); throw error; }
    return this.status();
  }

  async pair() {
    let pairing = this.state.pairing;
    if (!pairing || pairing.expiresAt <= this.now() || pairing.redeeming) {
      // Only an explicit start can replace an expired or uncertain pairing.
      if (this.state.status !== 'starting') throw new BridgeError('game_pairing_restart_required', '游戏配对已过期或结果未知，请停止后明确重新开始。');
      const result = await this.request('/api/v1/pairings', { body: { label: '碳硅派对 DSH 小游戏（需games:play）' }, signal: this.abort.signal });
      if (!result?.device_code || !result.user_code) throw new BridgeError('invalid_game_pairing', '游戏配对响应不完整。');
      this.state.pairing = { deviceCode: result.device_code, userCode: result.user_code,
        expiresAt: this.now() + (result.expires_in || 600) * 1000,
        nextPoll: this.now() + Math.max(5, result.interval || 5) * 1000, redeeming: false };
      this.state.status = 'awaiting_approval'; this.save(); return;
    }
    if (pairing.nextPoll > this.now()) { this.state.status = 'awaiting_approval'; return; }
    pairing.redeeming = true; this.save();
    let result;
    try { result = await this.request('/api/v1/pairings/token', { body: { device_code: pairing.deviceCode }, signal: this.abort.signal }); }
    catch (error) {
      if (error.code === 'authorization_pending') {
        pairing.redeeming = false; pairing.nextPoll = this.now() + 5000; this.state.status = 'awaiting_approval'; this.save(); return;
      }
      this.state.status = 'pairing_result_unknown'; this.save(); throw error;
    }
    if (!result?.token || !result.grant_id || result.actor_id !== this.state.identity.actorId) throw new BridgeError('game_identity_mismatch', '请将游戏授权批准给原来连接的同一个AI。');
    const me = await this.request('/api/v1/me', { token: result.token, signal: this.abort.signal });
    if (me.actor?.id !== result.actor_id || me.actor?.kind !== 'ai' || !me.scopes?.includes('games:play')) {
      this.state.pairing = null; this.save();
      throw new BridgeError('game_scope_required', '请重新批准同一个AI的games:play权限；原人设授权未改变。');
    }
    this.state.binding = { token: result.token, actorId: result.actor_id, grantId: result.grant_id };
    this.state.pairing = null; this.state.status = 'starting'; this.save();
  }

  async openControl() {
    const me = await this.request('/api/v1/me', { token: this.state.binding.token, signal: this.abort.signal });
    if (me.actor?.id !== this.state.identity.actorId || me.actor?.kind !== 'ai') throw new BridgeError('game_identity_mismatch', '游戏授权身份不一致。');
    if (!me.scopes?.includes('games:play')) throw new BridgeError('game_scope_required', '已有游戏授权缺少games:play，须经用户重新批准。');
    this.actor = copy(me.actor);
    const started = this.monotonic();
    const value = await this.request('/api/v1/agent/control/acquire', { token: this.state.binding.token,
      body: { instance_id: this.bridge.state.instanceId }, signal: this.abort.signal });
    this.validateLease(value, started, true);
    const configuration = await this.api('/agent/configuration');
    if (configuration.actor?.id !== this.actor.id || !configuration.persona) throw new BridgeError('game_persona_invalid', '该AI有权读取的社区人设身份不一致。');
    this.persona = { description: configuration.persona.description || '', effective: copy(configuration.persona.effective || {}) };
  }

  async renew() {
    if (this.sessionOwner) { this.ensureControl(); return; }
    this.ensureControl();
    if (this.monotonic() < this.lease.renewAt) return;
    const started = this.monotonic();
    const value = await this.request('/api/v1/agent/control/renew', { token: this.state.binding.token,
      body: { instance_id: this.bridge.state.instanceId, epoch: this.lease.epoch }, signal: this.abort.signal });
    this.validateLease(value, started, false);
  }

  journal(room) {
    const descriptor = { game_id: room.game_id, game_version: room.game_version, rules_version: room.rules_version };
    let journal = this.state.journals[room.id];
    if (!journal) journal = this.state.journals[room.id] = { game: descriptor, modelCalls: 0, requests: {}, readyKey: randomUUID(), readyControl: null, result: null };
    if (JSON.stringify(journal.game) !== JSON.stringify(descriptor) || !Number.isSafeInteger(journal.modelCalls) || journal.modelCalls < 0 || !journal.requests) throw new BridgeError('game_version_changed', '已保存对局版本不一致或进度无效。');
    return journal;
  }

  validateSnapshot(snapshot, roomId) {
    const room = snapshot?.room;
    if (snapshot?.protocol !== GAME_PROTOCOL || !room || room.id !== roomId ||
        ['game_id', 'game_version', 'rules_version', 'status'].some((k) => typeof room[k] !== 'string' || !room[k]) ||
        !snapshot.observation || typeof snapshot.observation !== 'object' || Array.isArray(snapshot.observation) ||
        !Number.isSafeInteger(snapshot.seq) || snapshot.seq < this.lastSeq) throw new BridgeError('invalid_game_snapshot', '游戏观察无效或倒退。');
    instant(snapshot.server_time); this.lastSeq = snapshot.seq;
    const req = snapshot.action_request;
    if (req != null && (!req.request_id || typeof req.request_id !== 'string' || !Number.isSafeInteger(req.based_on_revision) ||
      !Array.isArray(req.legal_actions) || !req.legal_actions.length || req.legal_actions.some((a) => !a || typeof a.action_id !== 'string' || !a.action_id) ||
      new Set(req.legal_actions.map((a) => a.action_id)).size !== req.legal_actions.length)) throw new BridgeError('invalid_game_request', '行动请求或合法动作无效。');
    if (req) instant(req.deadline_at);
    return room;
  }

  async chooseRoom() {
    let assignment = await this.api('/agent/game-assignment');
    if (!assignment || !Object.hasOwn(assignment, 'room')) throw new BridgeError('invalid_game_assignment', '游戏平台没有返回任务分配。');
    // A local game-only stop leaves the shared community connection alive.
    // Do not treat that same still-active server assignment as a new invitation.
    if (assignment.room && this.stoppedRooms.has(assignment.room.id)) {
      this.state.status = 'waiting_invitation'; this.save(); return null;
    }
    if (!assignment.room) {
      const pending = await this.api('/agent/game-invitations');
      this.state.pendingInvitations = (pending.invitations || []).map((i) => ({ id: i.id, room_id: i.room_id, status: i.status, name: i.name }));
      if (pending.auto_accept === true && this.sessionOwner?.preferences?.community?.paused !== true) {
        const invitation = this.state.pendingInvitations.find(i => i.status === 'pending' && !this.stoppedRooms.has(i.room_id));
        if (invitation) {
          try {
            await this.api(`/game-invitations/${resource(invitation.id)}/respond`, { accept: true }, `accept-${invitation.id}`);
          } catch (error) {
            // Pausing can race the invitation read; wait for explicit website
            // acceptance without stopping the shared diary/community runner.
            if (error.code !== 'community_paused') throw error;
            await this.sessionOwner?.refreshPreferences?.();
            this.state.status = 'waiting_invitation'; this.save(); return null;
          }
          this.recordExperience(`game-invitation:${invitation.id}`, 'game_invitation_accepted', invitation.room_id, '按网站设置接受了小游戏邀请。');
          assignment = await this.api('/agent/game-assignment');
          if (assignment.room) { this.state.roomId = assignment.room.id; this.lastSeq = -1; this.preparedLease = null; return assignment.room; }
        }
      }
      this.state.status = 'waiting_invitation'; this.save(); return null;
    }
    if (this.selectedRoom && assignment.room.id !== this.selectedRoom) throw new BridgeError('game_assignment_mismatch', '指定房间不是账号已接受的当前游戏。');
    resource(assignment.room.id);
    if (this.state.roomId !== assignment.room.id) {
      this.state.roomId = assignment.room.id; this.lastSeq = -1; this.preparedLease = null;
    }
    return assignment.room;
  }

  async prepare(room, journal) {
    const control = this.controlIdentity();
    const invitation = this.acceptedInvitation(room);
    const key = JSON.stringify(control) + ':' + room.id + ':' + (invitation?.id || journal.readyInvitation || '');
    if (this.preparedLease === key) return;
    const manifest = await this.api(`/games/${resource(room.game_id)}/manifest?version=${encodeURIComponent(room.game_version)}`);
    if (manifest?.protocol !== GAME_PROTOCOL || manifest.id !== room.game_id || manifest.version !== room.game_version || !supportsRulesVersion(manifest, room.rules_version)) throw new BridgeError('unsupported_game_version', '游戏或规则版本不匹配。');
    if (room.status === 'waiting') {
      if (JSON.stringify(journal.readyControl) !== JSON.stringify(control) ||
          (invitation && invitation.id !== journal.readyInvitation)) {
        journal.readyControl = control; journal.readyKey = randomUUID(); this.save();
      }
      if (invitation) journal.readyInvitation = invitation.id;
      this.save();
      try {
        await this.api(`/game-rooms/${room.id}/ready`, { game_version: room.game_version, rules_version: room.rules_version }, journal.readyKey);
        this.recordExperience(`game:${room.id}:ready:${invitation?.id || ''}`, 'game_joined', room.id, '接受邀请后，已为小游戏入桌做好准备。');
      } catch (error) {
        // Removal can race the state read. Let the next snapshot confirm it,
        // preserving the active AI lease and an uncertain ready request's key.
        if (error.code === 'invitation_accept_required' && invitation) return;
        if (error.code === 'community_paused') {
          await this.sessionOwner?.refreshPreferences?.();
          this.state.roomId = null; this.preparedLease = null; this.lastSeq = -1;
          this.state.status = 'waiting_invitation'; this.save(); return false;
        }
        throw error;
      }
      this.lastSeq = -1;
    }
    this.preparedLease = key;
  }

  acceptedInvitation(room) {
    return (room.invitations || []).find((i) => i.actor_id === this.actor.id && i.status === 'accepted');
  }

  waitingMembership(room, journal) {
    if (room.status !== 'waiting' || !Array.isArray(room.seats) || !Array.isArray(room.invitations)) return true;
    if (room.seats.some((s) => s.actor_id === this.actor.id)) return true;
    if (this.acceptedInvitation(room)) return true;
    journal.readyControl = null; journal.readyInvitation = null;
    this.state.roomId = null; this.preparedLease = null; this.lastSeq = -1;
    this.state.status = 'waiting_invitation'; this.state.pendingInvitations = [];
    this.save();
    return false;
  }

  finishChoice(snapshot, journal) {
    if (!this.active?.done) return;
    const task = this.active; this.active = null;
    const record = journal.requests[task.requestId];
    if (!record) return;
    const req = snapshot.action_request;
    if (task.error) { record.status = 'model_failed'; record.error = errorCode(task.error); this.save(); return; }
    if (!this.busy || this.abort.signal.aborted || snapshot.room.status !== 'playing' || !req || req.request_id !== task.requestId ||
      req.based_on_revision !== task.revision || this.monotonic() >= task.deadline ||
      JSON.stringify(record.control) !== JSON.stringify(this.controlIdentity())) {
      record.status = 'discarded_late';
      record.reason = !this.busy || this.abort.signal.aborted ? 'stopped' : this.monotonic() >= task.deadline ? 'expired' : 'state_changed';
      this.save(); return;
    }
    const choice = task.choice;
    if (!choice || !req.legal_actions.some((a) => a.action_id === choice.action_id) || typeof (choice.commentary ?? '') !== 'string' || (choice.commentary || '').length > 300) {
      record.status = 'model_failed'; record.error = 'invalid_model_decision'; this.save(); return;
    }
    record.payload = { request_id: req.request_id, based_on_revision: req.based_on_revision,
      decision: { action_id: choice.action_id }, commentary: (choice.commentary || '').trim() };
    record.status = 'pending'; this.save();
  }

  async flush(snapshot, journal) {
    for (const [requestId, record] of Object.entries(journal.requests)) {
      if (record.status !== 'pending') continue;
      const req = snapshot.action_request;
      if (!record.submittedOnce) {
        if (!req || req.request_id !== requestId || req.based_on_revision !== record.payload.based_on_revision ||
          snapshot.room.status !== 'playing' || this.monotonic() >= (this.deadlines.get(requestId) ?? -1) ||
          JSON.stringify(record.control) !== JSON.stringify(this.controlIdentity())) {
          record.status = 'discarded_late';
          record.reason = this.monotonic() >= (this.deadlines.get(requestId) ?? -1) ? 'expired' : 'state_changed';
          this.save(); continue;
        }
        record.submittedOnce = true; this.save();
      }
      try {
        const receipt = await this.api(`/game-rooms/${snapshot.room.id}/actions`, record.payload, record.key);
        if (receipt?.status !== 'accepted' || receipt.request_id !== requestId) throw new BridgeError('invalid_game_receipt', '游戏回执无法确认。', 502);
        record.status = 'accepted'; record.receipt = { status: receipt.status, request_id: receipt.request_id }; this.save();
      } catch (error) {
        if (CONTROL_ERRORS.has(error.code) || error.status >= 500) throw error;
        record.status = 'rejected'; record.error = errorCode(error); this.save();
      }
    }
  }

  async play(room) {
    const run = this.abort;
    const active = () => this.busy && this.state.enabled && this.abort === run && !run.signal.aborted;
    const started = this.monotonic();
    const snapshot = await this.api(`/game-rooms/${resource(room.id)}/state`);
    if (!active()) return;
    room = this.validateSnapshot(snapshot, room.id);
    const journal = this.journal(room), req = snapshot.action_request;
    if (!this.waitingMembership(room, journal)) return;
    let deadline;
    if (req) {
      const candidate = started + Math.max(0, instant(req.deadline_at) - instant(snapshot.server_time));
      deadline = Math.min(candidate, this.deadlines.get(req.request_id) ?? candidate);
      this.deadlines.set(req.request_id, deadline);
    }
    this.finishChoice(snapshot, journal);
    await this.flush(snapshot, journal);
    if (!active()) return;
    // A validated snapshot and reconciled action receipts supersede a previous
    // transient failure. Keep any NEW failure from prepare/stop below visible.
    this.state.error = null;
    if (FINISHED.has(room.status)) {
      this.recordExperience(`game:${room.id}:finished`, 'game_finished', room.id, `小游戏已结束（${room.status}）。`);
      journal.result = snapshot.result ?? null; this.save(); await this.stop(room.status); return;
    }
    if (await this.prepare(room, journal) === false) return;
    if (!active()) return;
    this.state.status = room.status; this.save();
    if (room.status !== 'playing' || !req || this.active || journal.requests[req.request_id] || this.monotonic() >= deadline) return;
    if (journal.modelCalls >= this.state.maxModelCalls) { await this.stop('budget_exhausted'); return; }
    if (!snapshot.rules || typeof snapshot.rules !== 'object') throw new BridgeError('game_rules_missing', '游戏平台未提供规则。');
    journal.requests[req.request_id] = { status: 'model_started', key: randomUUID(), control: this.controlIdentity() };
    journal.lastModelRequestId = req.request_id;
    journal.modelCalls += 1; this.save();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - this.monotonic()));
    timeout.unref?.();
    const signal = AbortSignal.any([controller.signal, this.abort.signal]);
    const ownerState = this.state, ownerIdentity = JSON.stringify(this.state.identity);
    const record = journal.requests[req.request_id];
    const task = { requestId: req.request_id, roomId: room.id, revision: req.based_on_revision, deadline,
      done: false, controller, ownerState, ownerIdentity };
    this.active = task;
    const context = {};
    for (const field of ['protocol', 'room', 'rules', 'observation', 'action_request', 'server_time', 'seq', 'result']) context[field] = copy(snapshot[field] ?? null);
    context.self = { id: this.actor.id, name: this.actor.name, kind: this.actor.kind };
    const onModelCall = value => {
      try {
        const callId = safeModelCallId(value);
        if (!callId || record.call_id || this.state !== ownerState || JSON.stringify(this.state.identity) !== ownerIdentity ||
          this.state.journals[room.id] !== journal || journal.requests[req.request_id] !== record) return;
        record.call_id = callId;
        this.save();
      } catch { /* Correlation persistence never changes a decision or its submission. */ }
    };
    task.promise = Promise.resolve().then(() => this.decide(context, { signal, deadline, persona: copy(this.persona), onModelCall }))
      .then((choice) => { task.choice = choice; }, (error) => { task.error = error; })
      .finally(() => { task.done = true; clearTimeout(timeout); });
  }

  async step() {
    if (!this.busy || !this.state.enabled || this.stepping) return this.status();
    this.stepping = true;
    try {
      await this.sessionOwner?.connectionReady?.();
      if (!this.state.binding) { await this.pair(); if (!this.state.binding) return this.status(); }
      if (!this.lease) await this.openControl();
      await this.renew();
      // Keep a completed room long enough to resolve uncertain action receipts.
      const previous = this.state.journals[this.state.roomId];
      const uncertain = previous && Object.values(previous.requests).some((r) => r.status === 'pending' && r.submittedOnce);
      const room = this.state.roomId && (this.preparedLease || uncertain) ? { id: this.state.roomId } : await this.chooseRoom();
      if (room) await this.play(room);
      else { this.state.error = null; this.save(); }
    } catch (error) {
      if (!this.state.enabled) return this.status();
      if (error.community_transport && this.sessionOwner?.recoverable?.()) {
        this.state.status = 'connection_interrupted'; this.save();
        try { await this.sessionOwner.recoverConnection(); this.state.error = null; }
        catch (recoveryError) { this.state.error = errorCode(recoveryError); await this.stop(errorCode(recoveryError)); }
        // Return to a new snapshot. Never replay a game action blindly or
        // extend the original model/turn deadline after reconnecting.
        return this.status();
      }
      this.state.error = errorCode(error);
      if (error.status >= 500 && this.lease && this.monotonic() < this.lease.deadline && this.state.status !== 'pairing_result_unknown') {
        this.state.status = 'connection_interrupted'; this.save();
      } else { await this.stop(errorCode(error)); }
    } finally { this.stepping = false; }
    return this.status();
  }

  async attachSession(owner, binding) {
    if (this.busy && this.sessionOwner !== owner) throw new BridgeError('control_busy', '游戏控制端已在其他会话运行。');
    if (this.state.identity && (this.state.identity.baseUrl !== binding.baseUrl || this.state.identity.actorId !== binding.actorId)) throw new BridgeError('game_connection_changed', '已保存的游戏进度属于另一个伙伴，原数据保留。');
    this.sessionOwner = owner;
    this.state.identity = { baseUrl: binding.baseUrl, actorId: binding.actorId };
    // Reuse the existing account credential only in memory; save() omits it.
    this.unifiedBinding = { ...binding }; this.state.binding = this.unifiedBinding;
    this.state.enabled = true; this.state.status = 'waiting_invitation'; this.state.error = null;
    this.busy = true; this.abort = new AbortController();
    this.ownerAbort = () => this.abort.abort(); owner.abort.signal.addEventListener('abort', this.ownerAbort, { once: true });
    this.lease = owner.lease; this.actor = owner.actor; this.persona = await owner.configuration();
    this.state.roomId = null; this.preparedLease = null; this.lastSeq = -1;
  }

  recordExperience(id, kind, roomId, summary) {
    this.sessionOwner?.diary?.record({ id, occurred_at: new Date().toISOString(), kind, reaction: null,
      resource: { room_id: roomId, game_id: this.state.journals[roomId]?.game?.game_id || null },
      reflection: '', summary, reply: null, related_entry_id: null });
  }

  async stopCurrent() {
    if (this.state.roomId) this.stoppedRooms.add(this.state.roomId);
    else this.participationPaused = true;
    this.selectedRoom = null;
    // A running game may carry a transient read error; an already stopped
    // controller's fatal error must still reach the owning community runner.
    if (this.busy) this.state.error = null;
    return this.stop();
  }

  async stop(reason = 'stopped') {
    this.state.enabled = false; this.state.status = reason;
    clearInterval(this.timer); this.timer = null;
    this.abort?.abort(); this.active?.controller.abort();
    const task = this.active;
    if (task && task.ownerState === this.state && task.ownerIdentity === JSON.stringify(this.state.identity)) {
      const record = this.state.journals[task.roomId]?.requests[task.requestId];
      if (record?.status === 'model_started') record.reason = 'stopped';
    }
    const lease = this.lease; this.lease = null;
    if (lease && this.state.binding && !this.sessionOwner) {
      try { await this.request('/api/v1/agent/control/release', { token: this.state.binding.token,
        body: { instance_id: this.bridge.state.instanceId, epoch: lease.epoch } }); }
      catch { this.state.error = this.state.error || 'control_release_unconfirmed'; }
    }
    this.busy = false; this.active = null; this.preparedLease = null;
    if (this.sessionOwner) {
      this.sessionOwner.abort.signal.removeEventListener('abort', this.ownerAbort);
      this.sessionOwner = null; this.state.roomId = null;
    }
    this.save(); return this.status();
  }
}
