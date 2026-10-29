import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RuntimeApi, atomicState, readState, fail, identifier, publicError } from './runtime-api.js';
import { RecoveringRuntimeApi, recover } from './runtime-recovery.js';
import { RUNTIME_SCOPES } from './runtime-connection.js';
import { FIELDS } from './core.js';
import { safeModelCallId } from './model-call-log.js';
import { LocalDiary } from './local-diary.js';
import { normalizePostDraft, flushDraftRequest, serviceProactiveDraft, refreshDrafts, publicDraftNotice } from './proactive-drafts.js';
import { MediaClient, readPostVideos, readVideoContext } from './media-client.js';
import { EngagementClient, ENGAGEMENT_WRITES, ENGAGEMENT_NOTICE, validateEngagement, definiteEngagementRejection } from './engagement-client.js';

const DEFERRED = new Set(['participation_full', 'not_selected', 'insight_pending', 'participation_unavailable']);
const SLOT_RETRY = new Set(['participation_required', 'participation_control_changed', 'participation_expired']);
const BEHAVIOR_PAUSED = new Set(['community_paused', 'community_quiet', 'auto_post_disabled', 'proactive_comments_disabled', 'interaction_reply_disabled', 'reply_limit_reached']);
const RUNNING = new Set(['observing', 'thinking', 'submitting']);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const cursorValue = value => typeof value === 'string' && /^\d+$/.test(value);
// Share one durable decision for a reply and @ targeting the same content.
// A post mention also shares the existing browse key with discovery.
const contentAction = (postId, parentId = null) => parentId !== null ? `comment:${parentId}` : `browse:${postId}`;
const modelFinishKinds = new Set(['none', 'unknown', 'stop', 'max-tokens', 'tool-calls', 'error', 'aborted']);
const modelFailureCodes = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT', 'SERVER', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'PI_AI_ERROR', 'ABORTED', 'CONTENT_FILTER', 'REFUSAL', 'UNKNOWN']);
const modelCallStatuses = new Set(['generating', 'model_failed', 'declined', 'pending', 'submitted', 'discarded']);
const modelDiscardReasons = new Set(['stopped', 'expired', 'state_changed']);
function publicModelCall(value) {
  const id = safeModelCallId(value?.call_id);
  return id && modelCallStatuses.has(value?.status) ? { call_id: id, status: value.status,
    reason: modelDiscardReasons.has(value.reason) ? value.reason : null } : null;
}
function publicModelDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const count = key => integer(value[key]) ? value[key] : null;
  return { finishKind: modelFinishKinds.has(value.finishKind) ? value.finishKind : 'unknown',
    failureCode: modelFailureCodes.has(value.failureCode) ? value.failureCode : null,
    maxTokens: count('maxTokens'), textCharacters: count('textCharacters'), reasoningCharacters: count('reasoningCharacters'),
    inputTokens: count('inputTokens'), outputTokens: count('outputTokens') };
}
const encodeQuery = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();

export function personaValues(configuration, actorId) {
  if (configuration?.actor?.id !== actorId || configuration.actor.kind !== 'ai' || typeof configuration.persona?.description !== 'string') throw fail('invalid_configuration', '社区人设配置与当前 AI 不一致。');
  const effective = {};
  for (const field of FIELDS) {
    const value = configuration.persona.effective?.[field];
    if (typeof value !== 'string') throw fail('invalid_configuration', '社区人设配置缺少有效属性。');
    effective[field] = value;
  }
  return { description: configuration.persona.description, effective };
}
export function publicDiscussion(post, comments, actor, parentId, hasMore, persona, videoMaterial = []) {
  const author = value => ({ id: value?.id, name: value?.name, kind: value?.kind });
  const item = (value, comment = false) => ({ id: value.id, body: value.body, author: author(value.author),
    source: value.source, ai_generated: value.ai_generated, published_at: value.published_at,
    ...(comment ? { parent_id: value.parent_id,
      ...(Array.isArray(value.extensions?.reply_recipient_ids) && value.extensions.reply_recipient_ids.every(x => typeof x === 'string')
        ? { reply_recipient_ids: value.extensions.reply_recipient_ids } : {}) }
      : { title: value.title, content: (Array.isArray(value.content) ? value.content : []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text })),
        ...(videoMaterial.length ? { video_material: videoMaterial } : {}) }) });
  return { self: { ...author(actor), ...(actor.relationship === 'companion' && typeof actor.linked_human_id === 'string' ? { linked_human_id: actor.linked_human_id } : {}) },
    post: item(post), comments: comments.filter(c => (c.status || 'published') === 'published').map(c => item(c, true)),
    reply_to_comment_id: parentId, persona,
    comments_page: { page: 'first', limit: 50, has_more: !!hasMore, includes_reply_target: !!parentId },
    context_notice: '这里只提供评论第一页（最多50条）及必要的目标回复，不是完整历史。只能依据这些公开内容回答，不访问媒体链接。' };
}

export class CommunityRuntime {
  constructor({ directory, connection, decide, summarize, draftModel, searchWeb, isHostIdle = () => true, wallNow = () => Date.now(), gameRuntime, fetchImpl, now = () => performance.now(), intervalMs = 5000, presenceMs = 15000, reconnectDelays = [2000, 5000, 10000, 30000] }) {
    this.directory = directory; this.connection = connection; this.decide = decide; this.fetch = fetchImpl; this.now = now;
    this.intervalMs = intervalMs; this.presenceMs = presenceMs; this.task = null; this.phase = 'stopped'; this.detail = 'not_started';
    this.state = null; this.stateFile = null; this.error = null; this.lease = null; this.presence = 'unknown'; this.presenceTask = Promise.resolve();
    this.summarize = summarize; this.gameRuntime = gameRuntime; this.preferences = null;
    this.draftModel = draftModel; this.searchWeb = searchWeb; this.isHostIdle = isHostIdle; this.wallNow = wallNow;
    this.reconnectDelays = reconnectDelays; this.recoveryTask = null; this.reconnect = null;
    this.loadDisplayState();
  }
  running() { return this.task !== null; }
  binding() {
    const b = this.connection.binding();
    if (!b) throw fail('runtime_authorization_required', '当前只有人设连接。请先明确申请社区运行授权，并在社区批准。');
    return b;
  }
  pathFor(binding) { return join(this.directory, `${createHash('sha256').update(`${binding.baseUrl}\n${binding.actorId}`).digest('hex')}.json`); }
  loadDisplayState() {
    const b = this.connection.binding();
    if (!b || this.running()) return;
    try { this.load(b); } catch (error) { this.error = publicError(error); }
  }
  load(binding) {
    const path = this.pathFor(binding), saved = readState(path);
    const state = saved || { version: 1, identity: { base_url: binding.baseUrl, actor_id: binding.actorId },
      model_calls: 0, replies: 0, posts: 0, cursor: '0', discovery_cursor: '0', completed: [], pending: null };
    if (state.version !== 1 || state.identity?.base_url !== binding.baseUrl || state.identity?.actor_id !== binding.actorId ||
        !integer(state.model_calls) || !integer(state.replies) || !integer(state.posts) || !cursorValue(state.cursor) ||
        !cursorValue(state.discovery_cursor) || !Array.isArray(state.completed) || !state.completed.every(x => typeof x === 'string')) {
      throw fail('runtime_state_invalid', '运行状态格式或账号不符；原计数与文件保留，不自动重置。');
    }
    if (state.deferred_pending !== undefined && !Array.isArray(state.deferred_pending)) throw fail('runtime_state_invalid', '暂缓原稿格式无效，原文件保留。');
    // Older versions persisted an uncertain draft here before receiving its id.
    // Replay the original bytes/key: adding new defaults changes its receipt fingerprint.
    const legacyDraft = state.post_draft && !state.post_draft.id ? state.post_draft : null;
    if (legacyDraft) {
      if (state.draft_request && (state.draft_request.key !== legacyDraft.key ||
          JSON.stringify(state.draft_request.payload) !== JSON.stringify(legacyDraft.payload))) {
        throw fail('pending_draft_conflict', '检测到两份不同的未确认草稿；两份原稿均保留，请先处理旧请求，未覆盖或提交。');
      }
      state.draft_request = { ...legacyDraft, ...state.draft_request, attempted: true };
    }
    if (state.draft_request) {
      const request = state.draft_request;
      if (typeof request.key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(request.key)) throw fail('runtime_state_invalid', '待审核草稿编号无效，原文件保留。');
      normalizePostDraft(request.payload);
    }
    if (['reading_cursor', 'browse_cursor'].some(key => state[key] !== undefined && !cursorValue(state[key])) ||
        (state.reading_waiting !== undefined && (!Array.isArray(state.reading_waiting) || state.reading_waiting.some(id => typeof id !== 'string')))) {
      throw fail('runtime_state_invalid', '阅读进度格式无效，原记录保留。');
    }
    for (const p of [state.pending, ...(state.deferred_pending || [])]) {
      if (p && (!['comment', 'post'].includes(p.kind) || typeof p.key !== 'string' || typeof p.action !== 'string' || !p.payload ||
          typeof p.payload.body !== 'string' || (p.kind === 'comment' && typeof p.post_id !== 'string'))) throw fail('runtime_state_invalid', '待发原稿不完整；原文件保留。');
    }
    if (state.pending_engagement) {
      try {
        const p = state.pending_engagement, args = validateEngagement(p.args);
        if (!ENGAGEMENT_WRITES.includes(args.action) || typeof p.key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.key) || typeof p.uncertain !== 'boolean') throw new Error('invalid');
      } catch { throw fail('runtime_state_invalid', '待确认互动格式无效，原文件保留。'); }
    }
    this.state = state; this.stateFile = path;
    if (legacyDraft) atomicState(path, state);
    this.diary = new LocalDiary({ directory: join(this.directory, 'local-memory'), baseUrl: binding.baseUrl, actorId: binding.actorId });
  }
  commit(patch) { const next = { ...this.state, ...patch }; atomicState(this.stateFile, next); this.state = next; }
  async refreshIdleDraftNotices() {
    const binding = this.connection.binding();
    if (this.running() || !binding || !this.state || this.idleDraftRefresh ||
        (this.idleDraftCheckedAt !== undefined && this.wallNow() - this.idleDraftCheckedAt < 15000)) return;
    this.idleDraftCheckedAt = this.wallNow(); this.idleDraftRefresh = true;
    const snapshot = this.state;
    try {
      const api = new RuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch });
      const response = await api.data('/api/v1/agent/post-drafts');
      const current = this.connection.binding();
      if (this.running() || this.state !== snapshot || !current || current.baseUrl !== binding.baseUrl ||
          current.actorId !== binding.actorId || current.token !== binding.token || !Array.isArray(response?.drafts)) return;
      const notices = response.drafts.filter(d => d.status === 'pending').map(d => publicDraftNotice(binding.baseUrl, d));
      if (JSON.stringify(notices) !== JSON.stringify(this.state.draft_notices || [])) this.commit({ draft_notices: notices });
    } catch { /* A read-only reminder refresh must not restart, publish, or alter runtime errors. */ }
    finally { this.idleDraftRefresh = false; }
  }
  completedFor(action, postId, parentId = null, submitted = false) {
    return [...new Set([...this.state.completed, action, contentAction(postId, parentId), ...(submitted ? [`submitted:${contentAction(postId, parentId)}`] : [])])];
  }
  publicStatus() {
    const s = this.state, p = s?.pending;
    return { mode: this.mode || null, state: this.phase, detail: this.detail, running: this.running() && !this.abort?.signal.aborted,
      stopping: this.running() && !!this.abort?.signal.aborted, presence: this.presence,
      reconnect: this.reconnect,
      identity: s?.identity || null, model_calls: s?.model_calls || 0, replies: s?.replies || 0, posts: s?.posts || 0,
      cursor: s?.cursor || '0', limits: this.limits || null, error: this.error,
      preferences: this.preferences, diary: this.diary?.status() || null, game: this.gameRuntime?.status() || null,
      post_draft: s?.post_draft || null,
      draft_notices: s?.draft_notices || [], draft_request: s?.draft_request ? { queued: true, attempted: !!s.draft_request.attempted, title: s.draft_request.payload.title } : null,
      draft_schedule: s?.draft_schedule ? { next_at: s.draft_schedule.next_at, result: s.draft_schedule.result || null } : null,
      engagement: {pending: s?.pending_engagement?.args || null, last: s?.last_engagement || null},
      last_model_diagnostic: publicModelDiagnostic(s?.last_model_diagnostic),
      last_model_call: publicModelCall(s?.last_model_call),
      last_decision: s?.last_decision || null,
      reading_cursor: s?.reading_cursor || '0',
      pending: p ? { kind: p.kind, post_id: p.post_id, body: p.payload.body, title: p.payload.title, key: p.key, uncertain: p.attempted === true, call_id: safeModelCallId(p.call_id) } : null,
      deferred_pending_count: s?.deferred_pending?.length || 0,
      rejected_draft: s?.rejected_draft || null,
      last_submission: s?.last_submission ? { ...s.last_submission, call_id: safeModelCallId(s.last_submission.call_id) } : null,
      control: this.lease ? { active: !this.abort?.signal.aborted && this.now() < this.lease.deadline, epoch: this.lease.epoch } : null };
  }
  noteModelCall(callId, status, reason = null) {
    const value = publicModelCall({ call_id: callId, status, reason });
    if (value) { try { this.commit({ last_model_call: value }); } catch { /* diagnostics cannot change whether a reply is submitted */ } }
  }
  validateOptions(options) {
    const limits = { max_model_calls: options.max_model_calls ?? 10, max_replies: options.max_replies ?? 10, max_posts: options.max_posts ?? 1 };
    if (Object.values(limits).some(value => !integer(value, 1) || value > 1000000)) throw fail('invalid_budget', '累计调用、回复和发帖预算须为1至1000000的整数。');
    const interval = options.interval_seconds ?? this.intervalMs / 1000;
    const threshold = options.interest_threshold ?? 0.25;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 3 || interval > 3600 || typeof threshold !== 'number' || threshold <= 0 || threshold > 1) throw fail('invalid_options', '观察间隔须为3至3600秒，兴趣门槛须大于0且不超过1。');
    if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200)) throw fail('invalid_options', '搜索词最多200字。');
    return { limits, interval: interval * 1000, threshold, query: options.query };
  }
  start(options = {}) {
    if (this.running()) throw fail('runtime_busy', '运行程序已启动，请先停止再更改运行方式。');
    const binding = { ...this.binding(), scopes: [...this.binding().scopes] };
    const mode = options.mode || 'single';
    if (!['single', 'watch', 'game', 'publish_post', 'engagement'].includes(mode)) throw fail('invalid_mode', '运行方式无效。');
    const input = this.validateOptions(options);
    const engagement = mode === 'engagement' ? (options.engagement?.action === 'retry_engagement' && Object.keys(options.engagement).length === 1 ? options.engagement : validateEngagement(options.engagement)) : null;
    let post;
    if (mode === 'publish_post') {
      post = normalizePostDraft(options);
    }
    this.mode = mode;
    if (mode !== 'engagement') { this.limits = input.limits; this.query = input.query; this.threshold = input.threshold; this.pollInterval = input.interval; }
    this.abort = new AbortController(); this.error = null; this.phase = 'observing'; this.detail = 'connecting'; this.presence = 'unknown'; this.instanceId = randomUUID();
    this.reconnect = null; this.recoveryTask = null; this.currentBinding = binding;
    this.engagementResult = null; this.engagementFailure = null;
    this.draftRunKey = null;
    this.task = this.run(binding, post, engagement).catch(error => { this.error = publicError(error); this.engagementFailure = error; this.phase = 'error'; }).finally(() => { this.task = null; });
    return this.publicStatus();
  }
  stop() {
    if (this.running()) { this.phase = 'stopped'; this.detail = 'user_stopped'; this.abort.abort(); }
    return this.publicStatus();
  }
  async requestDraft(options, signal) {
    const payload = normalizePostDraft({ ...options, initiation: 'requested' });
    signal?.throwIfAborted();
    if (this.running()) {
      if (!this.state || this.abort?.signal.aborted || !['watch', 'game'].includes(this.mode)) throw fail('runtime_busy', '请等待当前操作结束，再提交草稿。');
      if (this.preferences?.community?.paused) throw fail('community_paused', '社区自主活动已暂停；请先在网页恢复，DSH 不会代为更改设置。');
      if (this.state.draft_request && JSON.stringify(this.state.draft_request.payload) !== JSON.stringify(payload)) throw fail('pending_draft', '已有待提交草稿，请先确认原草稿的结果。');
      if (!this.state.draft_request) this.commit({ draft_request: { key: randomUUID(), payload } });
      return { queued: true, notice: '草稿已保存在本机，当前游戏或操作结束后提交；提交成功后会显示碳硅网页审核链接。尚未发表。' };
    }
    this.start({ ...options, mode: 'publish_post' });
    const stop = () => this.stop();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) this.stop();
      await this.settled();
      if (this.error) throw fail(this.error.code, this.error.message);
      if (this.draftRunKey && this.state.post_draft?.key === this.draftRunKey && !this.state.draft_request) {
        return { draft: this.state.post_draft, notice: this.state.post_draft.status === 'rejected' ? '这篇草稿之前已被拒绝，没有再次提议或发表。' : this.state.post_draft.status === 'published' ? '服务器确认这是之前已经发表的同一草稿，没有重复发表。' : '草稿已提交，请在碳硅网页审核。DSH 中的同意不会直接发表。' };
      }
      return { queued: !!this.state.draft_request, status: this.abort?.signal.aborted ? 'stopped_or_deferred' : 'deferred', notice: '尚未确认本次草稿上传成功。已保存的原稿保留，请恢复允许的运行后继续；没有发布。' };
    } finally { signal?.removeEventListener('abort', stop); }
  }
  startGame({ maxModelCalls, roomId } = {}) {
    const game = this.gameRuntime;
    if (!game) throw fail('game_runtime_unavailable', '游戏运行状态无法载入。');
    if (maxModelCalls !== undefined && (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 10000)) throw fail('invalid_game_budget', '模型调用预算须为1至10000。');
    if (roomId !== undefined && roomId !== null && (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(roomId))) throw fail('invalid_game_id', '游戏资源编号无效。');
    game.stoppedRooms.clear();
    game.participationPaused = false;
    game.selectedRoom = roomId || null;
    if (maxModelCalls !== undefined) { game.state.maxModelCalls = maxModelCalls; game.save(); }
    if (!this.running()) this.start({ mode: 'game' });
    return { ...game.status(), companion: this.publicStatus() };
  }
  async stopGame() {
    if (this.mode === 'game') {
      // This run was started solely for games; there is no earlier observation
      // to resume. A stop must not silently turn it into a community watcher.
      this.stop(); await this.settled();
    } else if (this.running() && this.gameRuntime && (!this.gameRuntime.sessionOwner || this.gameRuntime.sessionOwner === this)) {
      await this.gameRuntime.stopCurrent();
    }
    return { ...this.gameRuntime?.status(), companion: this.publicStatus() };
  }
  async settled() { await this.task; return this.publicStatus(); }
  recoverable() { return ['watch', 'game'].includes(this.mode); }
  validateIdentity(me, binding) {
    const actual = Object.hasOwn(me || {}, 'effective_scopes') ? me.effective_scopes : me?.scopes;
    if (me?.actor?.id !== binding.actorId || me.actor.kind !== 'ai' || !Array.isArray(actual) || actual.some(scope => typeof scope !== 'string') || RUNTIME_SCOPES.some(scope => !actual.includes(scope)) || actual.includes('manage') || me.scopes?.includes('manage')) throw fail('runtime_identity_mismatch', '运行授权身份或权限不匹配；未调用模型或发表。');
    return actual;
  }
  async connectionReady() {
    if (this.recoveryTask) await this.recoveryTask;
    if (this.abort?.signal.aborted) throw fail('run_stopped', '运行已停止。');
    if (this.recoverable() && this.lease && this.now() >= this.lease.deadline) await this.recoverConnection();
  }
  recoverConnection() {
    if (!this.recoveryTask) {
      this.recoveryTask = recover(this).catch(error => {
        if (!this.abort.signal.aborted) { this.error = publicError(error); this.phase = 'error'; this.abort.abort(); }
        throw error;
      }).finally(() => { this.recoveryTask = null; this.reconnect = null; });
    }
    return this.recoveryTask;
  }
  async acquireControl() {
    // Before the first confirmed lease there is no epoch to reconcile. An
    // uncertain initial acquisition requires an explicit restart, not a retry
    // that could undo a manager disconnect made during the missing response.
    const started = this.now();
    const lease = await this.api.data('/api/v1/agent/control/acquire', { body: { instance_id: this.instanceId }, signal: this.abort.signal, timeoutMs: 5000 });
    this.validateLease(lease, started, true);
  }
  checkActive() {
    if (this.abort?.signal.aborted) throw fail('run_stopped', '运行已停止；不会提交新的回复。');
    if (!this.lease || this.now() >= this.lease.deadline) throw fail('control_lost', '控制权已经到期，运行已停止。');
  }
  proof() { this.checkActive(); return { 'X-AI-Instance-ID': this.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) }; }
  budget(kind = 'model') {
    if (kind === 'diary') {
      if (this.state.model_calls >= this.limits.max_model_calls) throw fail('budget_exhausted', '已到本地累计模型调用预算。');
      return;
    }
    if (this.preferences) {
      if (kind === 'model' && this.state.model_calls >= this.limits.max_model_calls) throw fail('budget_exhausted', '已到本地累计模型调用预算。');
      if (kind === 'reply' && this.preferences.community?.reply_remaining === 0) throw fail('behavior_paused', '账号累计回复额度已用完。');
      if (this.preferences.community?.configured === true) return;
    }
    if (kind === 'post') {
      if (this.state.posts >= this.limits.max_posts) throw fail('budget_exhausted', '已到累计发帖预算；跨重启计数保留。');
    } else {
      if (this.state.replies >= this.limits.max_replies) throw fail('budget_exhausted', '已到累计回复预算；待发原稿和跨重启计数保留。');
      if (kind === 'model' && this.state.model_calls >= this.limits.max_model_calls) throw fail('budget_exhausted', '已到累计模型调用预算；失败调用也计数，跨重启保留。');
    }
  }
  validateLease(result, started, acquiring) {
    const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;
    const expiry = timestamp(result?.expires_at);
    const serverTime = timestamp(result?.server_time);
    const remaining = expiry - serverTime, delay = result?.renew_after_seconds ?? 15;
    if (!result?.active || !result.owned_by_current_grant || result.actor_id !== this.actor.id || !integer(result.epoch, 1) ||
        (!acquiring && result.epoch !== this.lease?.epoch) || !Number.isFinite(remaining) || remaining <= 0 ||
        typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0 || delay > 15 ||
        (!acquiring && this.now() >= this.lease.deadline)) throw fail('control_lost', '未获得有效控制权或续约已过期；运行已停止。');
    const deadline = started + Math.min(remaining, 60000);
    if (this.now() >= deadline) throw fail('control_lost', '控制权响应到达时已过期。');
    this.lease = { epoch: result.epoch, deadline, renewAfter: Math.min(delay * 1000, (deadline - this.now()) / 2) };
  }
  scheduleRenewal() {
    clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(async () => {
      const lease = this.lease;
      try {
        if (this.recoveryTask) return;
        if (this.recoverable() && this.now() >= this.lease.deadline) { await this.recoverConnection(); return; }
        this.checkActive(); const started = this.now();
        const result = await this.api.data('/api/v1/agent/control/renew', { body: { instance_id: this.instanceId, epoch: this.lease.epoch }, signal: this.abort.signal, timeoutMs: 5000 });
        if (this.recoveryTask || this.lease !== lease) return;
        this.checkActive(); this.validateLease(result, started, false); this.scheduleRenewal();
      } catch (error) {
        if (this.recoveryTask || this.lease !== lease) return;
        if ((error.community_transport || (error.code === 'control_lost' && this.lease && this.now() >= this.lease.deadline)) && this.recoverable() && !this.abort.signal.aborted) {
          try { await this.recoverConnection(); } catch { /* recovery records the terminal error */ }
          return;
        }
        if (!this.abort.signal.aborted) { this.error = publicError(error?.code === 'control_lost' ? error : fail('control_renewal_failed', '控制权续约失败；运行已停止，待发原稿保留。')); this.phase = 'error'; this.abort.abort(); }
      }
    }, this.lease.renewAfter);
    this.renewTimer.unref?.();
  }
  reportPresence() {
    if (this.features?.agent_presence !== true || !this.api || !this.lease || this.recoveryTask) return this.presenceTask;
    const requestedState = this.phase;
    const epoch = this.lease.epoch;
    const report = async () => {
      if (this.recoveryTask || this.lease?.epoch !== epoch) return;
      const state = requestedState, running = RUNNING.has(state) && !this.abort?.signal.aborted;
      try {
        if (running) await this.connectionReady();
        if (this.lease?.epoch !== epoch) return;
        const body = { instance_id: this.instanceId, state: running ? state : (state === 'error' ? 'error' : state === 'paused' ? 'paused' : 'stopped'),
          detail: this.detail, model_calls: this.state?.model_calls || 0, replies: this.state?.replies || 0 };
        const headers = running ? this.proof() : { 'X-AI-Instance-ID': this.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) };
        await this.api.data('/api/v1/agent/presence', { body, headers, timeoutMs: 5000 });
        if (!this.recoveryTask && this.lease?.epoch === epoch) this.presence = 'reported';
      } catch (error) {
        if (this.recoveryTask || this.lease?.epoch !== epoch) return;
        this.presence = error.status === 404 ? 'unsupported' : 'unknown';
        if (error.code === 'control_lost' && !this.abort?.signal.aborted) { this.error = publicError(error); this.phase = 'error'; this.abort.abort(); }
      }
    };
    this.presenceTask = this.presenceTask.then(report, report);
    return this.presenceTask;
  }
  phaseTo(state, detail) { if (!this.recoveryTask) { this.phase = state; this.detail = detail; void this.reportPresence(); } }
  async run(binding, post, engagement) {
    this.api = new RecoveringRuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch }, this);
    let acquired = false;
    try {
      const me = await this.api.data('/api/v1/me', { signal: this.abort.signal });
      const actual = this.validateIdentity(me, binding);
      this.actor = me.actor;
      binding.scopes = [...actual];
      this.currentBinding = binding;
      let capabilities;
      try { capabilities = await this.api.data('/api/v1/capabilities', { signal: this.abort.signal }); }
      catch (error) { if (error.status !== 404) throw error; capabilities = { features: {} }; }
      if (!capabilities?.features || typeof capabilities.features !== 'object') throw fail('invalid_capabilities', '社区能力信息不完整。');
      this.features = capabilities.features;
      this.presence = this.features.agent_presence === true ? 'unknown' : 'unsupported';
      await this.acquireControl(); acquired = true;
      this.checkActive(); this.load(binding); this.commit({}); this.scheduleRenewal();
      this.presenceTimer = setInterval(() => { void this.reportPresence(); }, this.presenceMs); this.presenceTimer.unref?.();
      this.phaseTo('observing', 'ready');
      await this.refreshPreferences();
      if (engagement) {
        await this.submitEngagement(engagement);
      } else if (post) {
        if (this.preferences?.community?.paused) throw fail('community_paused', '账号已暂停自主社交；请在网站恢复后再提交新草稿。', 403);
        if (this.state.pending) throw fail('pending_submission', '已有待确认原稿，请先运行一次以重试原请求，再发表新帖子。');
        this.budget('post'); this.checkActive();
        if (!this.preferences) throw fail('draft_review_unavailable', '社区未提供草稿审核功能；未尝试直接发表。');
        if (this.state.draft_request && JSON.stringify(this.state.draft_request.payload) !== JSON.stringify(post)) throw fail('pending_draft', '已有未确认草稿，请先处理原请求。');
        if (!this.state.draft_request) this.commit({ draft_request: { key: randomUUID(), payload: post } });
        this.draftRunKey = this.state.draft_request.key;
        await flushDraftRequest(this);
      } else {
        do {
          await this.connectionReady();
          this.checkActive();
          this.policyDeniedThisCycle = false;
          await this.refreshPreferences();
          let gaming = await this.serviceGame(binding);
          if (this.mode === 'game' && this.gameRuntime && !this.gameRuntime.busy) {
            if (this.state.draft_request) await flushDraftRequest(this);
            break;
          }
          if (!gaming) {
            if (this.state.draft_request && await flushDraftRequest(this) && this.mode === 'single') break;
            await this.serviceDiary();
            gaming = !!this.gameRuntime?.busy && !!this.gameRuntime.state.roomId;
            const reconciled = !gaming && (this.state.pending || this.state.deferred_pending?.length) ? await this.flushPending() : false;
            // Pausing autonomous activity must still leave the event channel
            // available for a server-verified request from the manager.
            if (!gaming && !reconciled && this.mode !== 'game' && this.communityAllowed(true)) {
              const acted = await this.pollOnce();
              if (!acted && !this.policyDeniedThisCycle && this.communityAllowed() && this.preferences?.community?.proactive_comments !== false) await this.browseOnce();
            }
            if (!gaming && !this.abort.signal.aborted) await serviceProactiveDraft(this);
          }
          if (!['watch', 'game'].includes(this.mode) && !gaming) break;
          if (!this.preferences) this.budget();
          this.phaseTo('observing', gaming ? 'playing_game' : this.communityAllowed() ? 'waiting' : 'account_paused');
          await this.wait(gaming ? 500 : this.pollInterval);
        } while (!this.abort.signal.aborted);
      }
      if (!this.abort.signal.aborted) this.phaseTo('stopped', 'cycle_complete');
    } catch (error) {
      if (engagement) this.engagementFailure = error;
      if (this.error && this.phase === 'error') this.phase = 'error';
      else if (error.code === 'budget_exhausted') { this.error = publicError(error); this.phase = 'paused'; this.detail = 'budget_exhausted'; }
      else if (this.abort.signal.aborted && this.phase !== 'error') { this.phase = 'stopped'; this.detail = 'user_stopped'; }
      else { this.error = publicError(error); this.phase = 'error'; this.detail = 'request_failed'; }
    } finally {
      if (this.gameRuntime?.sessionOwner === this) await this.gameRuntime.stop('host_stopped');
      this.abort.abort();
      clearTimeout(this.renewTimer); clearInterval(this.presenceTimer);
      try { await this.recoveryTask; } catch { /* already reflected in public state */ }
      if (acquired) {
        await this.reportPresence();
        try { await this.api.data('/api/v1/agent/control/release', { body: { instance_id: this.instanceId, epoch: this.lease.epoch }, timeoutMs: 5000 }); }
        catch { if (!this.error) this.error = { code: 'control_release_unconfirmed', message: '控制权释放结果未确认；运行已停止，租约到期后失效。' }; }
      }
      this.lease = null;
    }
  }
  wait(milliseconds) {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', stopped); resolve(); };
      const stopped = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', stopped); reject(fail('run_stopped', '运行已停止。')); };
      const timer = setTimeout(done, milliseconds);
      this.abort.signal.addEventListener('abort', stopped, { once: true });
      if (this.abort.signal.aborted) stopped();
    });
  }
  async refreshPreferences() {
    try {
      const value = await this.api.data('/api/v1/agent/preferences', { signal: this.abort.signal });
      if (!value?.community || !value?.diary) throw fail('invalid_preferences', '账号设置响应不完整。');
      this.preferences = value;
      if (value.community.configured === true) this.query = value.community.keywords || '';
      if ((this.state?.post_draft?.id && this.state.post_draft.status === 'pending') || this.state?.draft_notices?.length) {
        const drafts = await refreshDrafts(this);
        const draft = drafts.find(row => row.id === this.state.post_draft?.id);
        if (draft?.post_id && draft.status === 'published') {
          this.diary.record({ id: `post:${draft.post_id}`, occurred_at: draft.published_at || new Date().toISOString(), kind: 'post_published', reaction: null,
            resource: { post_id: draft.post_id, title: this.state.post_draft.payload.title, url: `${this.state.identity.base_url}/api/v1/posts/${draft.post_id}` },
            reflection: '', summary: '人类确认后发表了帖子。', reply: null, related_entry_id: null });
          this.commit({ post_draft: { ...this.state.post_draft, status: draft.status, post_id: draft.post_id }, posts: this.state.posts + 1 });
        }
        else if (draft?.status === 'rejected') this.commit({ post_draft: { ...this.state.post_draft, status: 'rejected' } });
      }
    } catch (error) { if (error.status !== 404) throw error; this.preferences = null; }
  }
  communityAllowed(managerAuthorized = false) {
    if (!this.preferences) return true;
    const p = this.preferences?.community;
    const explicitWhilePaused = p?.paused === true && managerAuthorized === true;
    if ((p?.paused && !explicitWhilePaused) || p?.reply_remaining === 0 || this.state.model_calls >= this.limits.max_model_calls) return false;
    if (p?.configured !== true && this.state.replies >= this.limits.max_replies) return false;
    if (explicitWhilePaused) return true;
    if (typeof p?.quiet_now === 'boolean') return !p.quiet_now;
    if (!p?.quiet_start || !p?.quiet_end) return true;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: this.preferences.diary.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const quiet = p.quiet_start <= p.quiet_end ? time >= p.quiet_start && time < p.quiet_end : time >= p.quiet_start || time < p.quiet_end;
    return !quiet;
  }
  async serviceGame(binding) {
    const game = this.gameRuntime;
    if (!game || game.participationPaused || !binding.scopes.includes('games:play')) return false;
    if (!game.sessionOwner) await game.attachSession(this, binding);
    // A game-only stop can arrive while attachSession awaits configuration.
    if (!game.sessionOwner && !game.busy) return false;
    if (game.sessionOwner !== this) throw fail('control_busy', '另一个游戏程序正在运行。');
    await game.step();
    if (game.state.error && !game.busy) throw fail('game_runtime_failed', '游戏运行已停止，请查看小游戏状态。');
    return !!game.state.roomId && game.busy;
  }
  async serviceDiary() {
    if (!this.preferences || !this.summarize) return false;
    const response = await this.api.data('/api/v1/agent/diary/jobs', { signal: this.abort.signal, headers: this.proof() });
    if (!Array.isArray(response?.jobs)) throw fail('invalid_diary_jobs', '日记任务列表无效。');
    const job = response.jobs.find(item => item.status === 'pending');
    if (!job) return false;
    this.phaseTo('thinking', 'writing_diary');
    const result = await this.diary.generate(job, { persona: await this.configuration(), summarize: this.summarize, signal: this.abort.signal,
      checkActive: async () => { await this.connectionReady(); this.checkActive(); }, beforeCall: async () => {
        if (this.currentBinding && await this.serviceGame(this.currentBinding)) throw fail('diary_deferred', '先完成已接受的小游戏，再继续日记。');
        this.budget('diary'); this.checkActive(); this.commit({ model_calls: this.state.model_calls + 1 });
      } });
    if (result.deferred) return false;
    this.checkActive();
    await this.write(`/api/v1/agent/diary/jobs/${identifier(job.id)}/result`, { ...result, attempt: job.attempt ?? 1 }, `diary-${job.id}-${job.attempt ?? 1}`);
    return true;
  }
  async get(path) { await this.connectionReady(); this.checkActive(); const result = await this.api.request(path, { signal: this.abort.signal }); await this.connectionReady(); this.checkActive(); return result; }
  async write(path, body, key, method) {
    await this.connectionReady();
    const headers = { ...this.proof(), ...(key ? { 'Idempotency-Key': key } : {}) };
    const result = await this.api.data(path, { body, headers, signal: this.abort.signal, ...(method ? { method } : {}) });
    await this.connectionReady(); this.checkActive(); return result;
  }
  async claim(postId, forPending = false) {
    let request = this.state.participation_request;
    if (!request || request.post_id !== postId || !!request.for_pending !== forPending) {
      request = { post_id: postId, request_id: randomUUID(), for_pending: forPending };
      this.commit({ participation_request: request });
    }
    const result = await this.write(`/api/v1/posts/${identifier(postId)}/participation`, { request_id: request.request_id });
    if (result?.post_id !== postId || typeof result.reserved !== 'boolean') throw fail('invalid_participation_response', '社区首次回应机会响应无效。');
    return result.reserved;
  }
  async flushPending({ retryParticipation = false } = {}) {
    if (!this.state.pending && !this.state.deferred_pending?.length) return false;
    // A manager can pause activity while the model is generating. Re-read
    // policy before any new submission; uncertain requests keep their keys.
    await this.refreshPreferences();
    if (!this.state.pending && this.state.deferred_pending?.length) {
      const next = this.state.deferred_pending.find(p => (!p.waiting_for_participation || retryParticipation) && this.pendingAllowed(p));
      if (next) this.commit({ pending: next, deferred_pending: this.state.deferred_pending.filter(p => p.key !== next.key) });
    }
    const p = this.state.pending;
    if (!p) return false;
    if (p.kind === 'post') {
      if (p.attempted) throw fail('legacy_post_unconfirmed', '旧版有一笔直接发帖的结果未确认，已保留原请求；请先核对社区，升级不会自动重新发表。');
      if (this.state.draft_request) return false;
      this.commit({ pending: null, draft_request: { key: p.key, payload: normalizePostDraft(p.payload) } });
      return flushDraftRequest(this);
    }
    if (!p.attempted && !this.pendingAllowed(p)) { this.deferPending(); return false; }
    this.checkActive(); if (!p.attempted) this.budget(p.kind === 'post' ? 'post' : 'reply');
    this.phaseTo('submitting', 'retrying_original');
    if (!p.attempted) this.commit({ pending: { ...p, attempted: true } });
    const send = () => this.write(p.kind === 'post' ? '/api/v1/posts' : `/api/v1/posts/${identifier(p.post_id)}/comments`, p.payload, p.key);
    let result;
    try { result = await send(); }
    catch (error) {
      if (BEHAVIOR_PAUSED.has(error.code)) {
        this.policyDeniedThisCycle = true; this.deferPending(); return true;
      }
      if (p.kind === 'post' && error.status === 422 && ['invalid_request', 'validation_error', 'invalid_topics', 'body_too_large'].includes(error.code)) {
        this.checkActive();
        this.commit({ pending: null, rejected_draft: { key: p.key, title: p.payload.title, body: p.payload.body, topics: p.payload.topics || [], error: publicError(error) } });
        throw fail('post_draft_rejected', '社区确认未受理这篇帖子。原稿已保存为可编辑草稿，请修改后重新发表；浏览与回复可以继续。', 422);
      }
      if (p.kind !== 'comment' || p.payload.parent_id !== null || !SLOT_RETRY.has(error.code)) throw error;
      try {
        if (!await this.claim(p.post_id, true)) { this.commit({ participation_request: null }); this.deferPending('participation'); return false; }
      } catch (claimError) {
        if (!DEFERRED.has(claimError.code) && claimError.code !== 'participation_control_changed') throw claimError;
        this.commit({ participation_request: null }); this.deferPending('participation'); return false;
      }
      result = await send();
    }
    if (typeof result?.id !== 'string' || !['published', 'queued'].includes(result.status)) throw fail('unknown_publish_result', '社区没有确认发表结果；待发原稿保留，重试将复用原请求编号。');
    if (p.kind === 'comment') this.diary.record({ id: `${p.action}:reply`, occurred_at: new Date().toISOString(), kind: 'comment_submitted', reaction: 'replied',
      resource: p.resource || { post_id: p.post_id, title: '', url: `${this.state.identity.base_url}/api/v1/posts/${p.post_id}` }, reflection: p.reflection || '',
      reply: { id: result.id, body: p.payload.body, status: result.status }, related_entry_id: p.reflection ? `${p.action}:read` : null });
    else this.diary.record({ id: `${p.action}:published`, occurred_at: new Date().toISOString(), kind: result.status === 'published' ? 'post_published' : 'post_submitted', reaction: null,
      resource: { post_id: result.id, title: p.payload.title, url: `${this.state.identity.base_url}/api/v1/posts/${result.id}` }, reflection: '',
      summary: result.status === 'published' ? '发表了一篇帖子。' : '提交了一篇帖子，等待展示。', reply: null, related_entry_id: null });
    this.commit({ [p.kind === 'post' ? 'posts' : 'replies']: this.state[p.kind === 'post' ? 'posts' : 'replies'] + 1,
      completed: p.kind === 'comment' ? this.completedFor(p.action, p.post_id, p.payload.parent_id, true) : [...this.state.completed, p.action],
      cursor: p.event_cursor && BigInt(p.event_cursor) > BigInt(this.state.cursor) ? p.event_cursor : this.state.cursor, pending: null, participation_request: null,
      last_submission: { id: result.id, status: result.status, kind: p.kind, post_id: p.post_id || result.id, call_id: safeModelCallId(p.call_id) } });
    this.noteModelCall(p.call_id, 'submitted');
    this.phaseTo('observing', result.status === 'queued' ? 'submission_queued' : 'submission_published');
    return true;
  }
  pendingAllowed(p) {
    const options = this.preferences?.community;
    if (!options) return true;
    const explicitWhilePaused = options.paused === true && p.kind === 'comment' && p.manager_authorized === true;
    if (((options.paused || options.quiet_now) && !explicitWhilePaused) || (p.kind === 'comment' && options.reply_remaining === 0)) return false;
    if (options.configured !== true && this.state[p.kind === 'post' ? 'posts' : 'replies'] >= this.limits[p.kind === 'post' ? 'max_posts' : 'max_replies']) return false;
    if (explicitWhilePaused) return true;
    return p.kind === 'post' ? options.auto_post === true : (p.payload.parent_id || p.action?.startsWith('event:')) ? options.reply_to_interactions !== false : options.proactive_comments !== false;
  }
  deferPending(reason = 'account') {
    const pending = this.state.pending;
    if (!pending) return;
    this.commit({ pending: null, deferred_pending: [...(this.state.deferred_pending || []).filter(p => p.key !== pending.key), { ...pending, attempted: false, waiting_for_participation: reason === 'participation' }] });
    this.phaseTo('observing', reason === 'participation' ? 'waiting_for_participation' : 'pending_account_paused');
  }
  actionKnown(action, postId = null, parentId = null, reconsider = false) {
    const deferred = this.state.deferred_pending || [];
    if (this.state.completed.includes(action) || deferred.some(p => p.action === action)) return true;
    if (postId === null) return false;
    const content = contentAction(postId, parentId);
    return (!reconsider && this.state.completed.includes(content)) || deferred.some(p => p.kind === 'comment' && contentAction(p.post_id, p.payload.parent_id) === content);
  }
  reconsiderHumanMention(postId, parentId, trigger) {
    if (trigger?.kind !== 'human_mention' || parentId !== null) return false;
    const content = contentAction(postId, parentId);
    if (!this.state.completed.includes(content) || this.state.completed.includes(`submitted:${content}`)) return false;
    const outcome = this.state.reading_outcomes?.[content];
    if (outcome) return outcome === 'browse_declined';
    // Before reading outcomes existed, successful replies were durably recorded
    // in the local diary. Do not reinterpret any such post as an unanswered skip.
    return ![...this.diary.entries()].some(row => row.kind === 'comment_submitted' && row.resource?.post_id === postId);
  }
  async configuration() { const value = (await this.get('/api/v1/agent/configuration')).data; return personaValues(value, this.actor.id); }
  async decideOn(postId, action, parentId = null, eventCursor = null, persona, managerAuthorized = false, trigger = null) {
    if (this.actionKnown(action, postId, parentId, this.reconsiderHumanMention(postId, parentId, trigger))) return false;
    this.checkActive(); this.budget();
    let post, response, comments, videoMaterial;
    try {
      post = (await this.get(`/api/v1/posts/${identifier(postId)}`)).data;
      videoMaterial = await readPostVideos((asset, cursor, limit) =>
        this.get(`/api/v1/media/assets/${identifier(asset)}/context?${encodeQuery({ cursor, limit, view: 'overview' })}`).then(value => value.data),
        post, { checkActive: () => this.checkActive() });
      response = await this.get(`/api/v1/posts/${identifier(postId)}/comments?limit=50`);
      if (!post || post.id !== postId || !Array.isArray(response.data)) throw fail('invalid_discussion', '帖子或评论响应不完整。');
      comments = response.data;
      if (parentId) {
        let parent = comments.find(c => c.id === parentId);
        if (!parent) {
          parent = (await this.get(`/api/v1/comments/${identifier(parentId)}`)).data;
          comments = [...comments, parent];
        }
        if (parent?.status !== 'published' || parent.id !== parentId || (parent.post_id && parent.post_id !== postId)) throw fail('invalid_reply_target', '目标回复尚未公开或不属于该帖子。');
      }
    } catch (error) {
      if (error.code === 'media_context_pending') {
        this.phaseTo('observing', 'video_context_pending'); return false;
      }
      // Only retire a confirmed unavailable content read. Authentication,
      // transport and uncertain publication errors keep their existing flow.
      if (error.status !== 404 || !['not_found', 'post_not_found', 'comment_not_found'].includes(error.code)) throw error;
      this.checkActive();
      this.commit({ completed: this.completedFor(action, postId, parentId), cursor: eventCursor && BigInt(eventCursor) > BigInt(this.state.cursor) ? eventCursor : this.state.cursor });
      this.phaseTo('observing', 'target_unavailable'); return true;
    }
    const context = publicDiscussion(post, comments, this.actor, parentId, response.next_cursor, persona || await this.configuration(), videoMaterial);
    context.trigger = trigger || { kind: action.startsWith('browse:') ? 'browse' : 'reply' };
    this.checkActive(); this.commit({ model_calls: this.state.model_calls + 1, last_model_diagnostic: null, last_model_call: null });
    this.phaseTo('thinking', 'reading_discussion');
    const stateFile = this.stateFile, callNumber = this.state.model_calls, identity = this.state.identity;
    let callId = null, decision;
    const sameCall = () => this.stateFile === stateFile && this.state?.identity === identity && this.state.model_calls === callNumber;
    const note = (status, reason = null) => { if (sameCall()) this.noteModelCall(callId, status, reason); };
    try {
      decision = await this.decide(context, this.abort.signal, value => {
        if (sameCall()) this.commit({ last_model_diagnostic: publicModelDiagnostic(value) });
      }, id => { callId = safeModelCallId(id); note('generating'); });
    } catch (error) {
      note(this.abort.signal.aborted ? 'discarded' : 'model_failed', this.abort.signal.aborted ? 'stopped' : null);
      throw error;
    }
    try { await this.connectionReady(); this.checkActive(); }
    catch (error) {
      note('discarded', error.code === 'run_stopped' ? 'stopped' : error.code === 'control_lost' ? 'expired' : 'state_changed');
      throw error;
    }
    if (!decision || typeof decision.participate !== 'boolean' || typeof decision.body !== 'string' || decision.body.length > 2000 || (decision.participate && !decision.body.trim())) {
      note('model_failed');
      throw fail('invalid_model_decision', '模型决定无效；本次调用已计数，未发表。');
    }
    if (decision.reflection !== undefined && (typeof decision.reflection !== 'string' || decision.reflection.length > 2000)) throw fail('invalid_model_decision', '本地感想格式无效。');
    if (decision.decision_note !== undefined && (typeof decision.decision_note !== 'string' || decision.decision_note.length > 240)) throw fail('invalid_model_decision', '参与决定的简短说明格式无效。');
    const readingDecision = { post_id: postId, reply_to_comment_id: parentId, participate: decision.participate, decision_note: decision.decision_note?.trim() || '',
      trigger: context.trigger.kind, occurred_at: new Date().toISOString(), call_id: callId };
    const readingOutcomes = { ...(this.state.reading_outcomes || {}), [contentAction(postId, parentId)]: decision.participate ? 'pending' : `${context.trigger.kind}_declined` };
    const reflection = decision.reflection?.trim() || '', resource = { post_id: postId, title: post.title || '', url: `${this.state.identity.base_url}/api/v1/posts/${postId}` };
    if (reflection) this.diary.record({ id: `${action}:read`, occurred_at: new Date().toISOString(), kind: 'post_read', reaction: 'noted', resource,
      reflection, reply: null, related_entry_id: null });
    if (!decision.participate) {
      this.commit({ completed: this.completedFor(action, postId, parentId), cursor: eventCursor && BigInt(eventCursor) > BigInt(this.state.cursor) ? eventCursor : this.state.cursor, participation_request: null,
        last_decision: readingDecision, reading_outcomes: readingOutcomes });
      note('declined');
      this.phaseTo('observing', 'chose_not_to_reply'); return true;
    }
    this.commit({ last_decision: readingDecision, reading_outcomes: readingOutcomes, pending: { kind: 'comment', key: randomUUID(), post_id: postId, action, event_cursor: eventCursor, call_id: callId, reflection, resource,
      manager_authorized: managerAuthorized === true,
      payload: { body: decision.body.trim(), parent_id: parentId, ai_generated: true } } });
    note('pending');
    await this.flushPending(); return true;
  }
  async pollOnce() {
    if (await this.flushPending()) return true;
    const response = await this.get(`/api/v1/events?${encodeQuery({ cursor: this.state.cursor, limit: 50 })}`);
    if (!Array.isArray(response.data)) throw fail('invalid_events', '社区事件响应不完整。');
    let current = BigInt(this.state.cursor), previous = -1n;
    for (const event of response.data) {
      const id = String(event?.id);
      if (!cursorValue(id) || BigInt(id) < previous) throw fail('invalid_event_cursor', '社区事件顺序无效；当前位置保留。');
      previous = BigInt(id);
    }
    const next = response.next_cursor === undefined || response.next_cursor === null ? null : String(response.next_cursor);
    if (next !== null && (!cursorValue(next) || BigInt(next) < previous)) throw fail('invalid_event_cursor', '社区事件位置无效；当前位置保留。');
    for (const event of response.data) {
      const id = String(event.id);
      if (BigInt(id) <= current) continue;
      const action = `event:${id}`;
      if (['friend.requested', 'friend.accepted'].includes(event.type) && event.reply_to_actor_id === this.actor.id) {
        if (['resource_id', 'author_id', 'created_at'].some(field => typeof event[field] !== 'string' || !event[field])) throw fail('invalid_friend_event', '好友事件缺少事实编号或时间。');
        const summary = event.type === 'friend.requested' ? `收到账号 ${event.author_id} 的好友申请` : '好友申请已被接受';
        // Persist only the reported fact; a self-authored acceptance is valid too.
        // Stable event IDs avoid another diary entry if cursor saving is retried.
        this.diary.record({ id: `${action}:friend`, occurred_at: event.created_at, kind: event.type.replace('.', '_'), reaction: null,
          resource: { post_id: null, title: '', url: null }, reflection: '', reply: null, related_entry_id: null,
          summary: `${summary}（关系编号：${event.resource_id}）。` });
      }
      // This hint is supplied by the event API, never by a model response.
      // The comment endpoint independently verifies the actual mention again.
      const managerAuthorized = event.manager_authorized === true;
      const replyAllowed = this.preferences?.community?.paused
        ? managerAuthorized && this.communityAllowed(true)
        : this.preferences?.community?.reply_to_interactions !== false && this.communityAllowed();
      if (replyAllowed && ['comment.published', 'comment.group_replied', 'post.mentioned', 'comment.mentioned'].includes(event.type) && event.reply_to_actor_id === this.actor.id && event.author_id !== this.actor.id && !this.actionKnown(action)) {
        if (!event.post_id || !event.resource_id) throw fail('invalid_reply_event', '回复事件缺少目标帖子或评论。');
        const parentId = event.type === 'post.mentioned' ? null : event.resource_id;
        if (parentId === null && event.resource_id !== event.post_id) throw fail('invalid_reply_event', '提及事件的帖子不匹配。');
        const trigger = { kind: event.type.endsWith('.mentioned') ? (event.author_kind === 'human' ? 'human_mention' : 'ai_mention') : 'reply', author_id: event.author_id,
          author_kind: event.author_kind, manager_authorized: managerAuthorized };
        if (!this.actionKnown(action, event.post_id, parentId, this.reconsiderHumanMention(event.post_id, parentId, trigger))) return this.decideOn(event.post_id, action, parentId, id, undefined, managerAuthorized, trigger);
      }
      this.checkActive(); this.commit({ cursor: id }); current = BigInt(id);
    }
    if (response.next_cursor !== undefined && response.next_cursor !== null) {
      if (BigInt(next) > current) { this.checkActive(); this.commit({ cursor: next }); }
    }
    return false;
  }
  async browseOnce() {
    // A full participation pool delays publication, never the next reading.
    // Retry one preserved participation request here, rather than in every
    // event/diary reconciliation within the same watch cycle.
    if (await this.flushPending({ retryParticipation: true })) return true;
    this.budget();
    for (const postId of [...(this.state.reading_waiting || [])]) {
      if (this.actionKnown(`browse:${postId}`, postId)) {
        this.commit({ reading_waiting: this.state.reading_waiting.filter(id => id !== postId) }); continue;
      }
      if (await this.decideOn(postId, `browse:${postId}`)) {
        this.commit({ reading_waiting: this.state.reading_waiting.filter(id => id !== postId) }); return true;
      }
    }
    const incremental = this.features.reading_after === true;
    let cursor = this.state[incremental ? 'reading_cursor' : 'browse_cursor'] || '0';
    for (;;) {
      this.checkActive();
      // This temporary all-posts mode deliberately sends neither interests nor
      // saved keywords. Discovery availability cannot silently filter the feed.
      const response = await this.get(`/api/v1/posts?${encodeQuery({ limit: 20, [incremental ? 'after' : 'cursor']: cursor })}`);
      if (!Array.isArray(response.data)) throw fail('invalid_posts', '帖子列表响应不完整。');
      const next = response.next_cursor == null ? null : String(response.next_cursor);
      const more = incremental ? response.has_more : next !== null;
      if ((next !== null && !cursorValue(next)) || (incremental && (next === null || typeof more !== 'boolean' || BigInt(next) < BigInt(cursor))) ||
          (more && (next === cursor || !response.data.length))) throw fail('invalid_reading_cursor', '帖子阅读分页没有有效前进，原进度保留。');
      for (const post of response.data) {
        identifier(post?.id);
        if (post?.author?.id === this.actor.id || this.actionKnown(`browse:${post.id}`, post.id) || this.state.reading_waiting?.includes(post.id)) continue;
        if (await this.decideOn(post.id, `browse:${post.id}`)) return true;
        // Media still being prepared must remain readable later without
        // preventing already-ready posts on subsequent pages from being read.
        this.commit({ reading_waiting: [...new Set([...(this.state.reading_waiting || []), post.id])] });
      }
      cursor = next ?? '0';
      this.commit({ [incremental ? 'reading_cursor' : 'browse_cursor']: cursor });
      if (!more) {
        if (!incremental && cursor !== '0') this.commit({ browse_cursor: '0' });
        this.phaseTo('observing', 'no_new_target'); return false;
      }
    }
  }
  async discoverOnce() {
    return this.browseOnce();
  }
  async exportActivity({ since, until, cursor = '0', limit = 50, format = 'json' } = {}) {
    const binding = this.binding();
    if (!binding.scopes.includes('posts:read')) throw fail('runtime_scope_required', '动态导出需要读取公开内容权限。');
    if (!['json', 'markdown'].includes(format) || !cursorValue(String(cursor)) || !integer(limit, 1) || limit > 100 || [since, until].some(v => v !== undefined && (typeof v !== 'string' || v.length > 80))) throw fail('invalid_export', '动态导出的格式、范围或分页参数无效。');
    return new RuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch }).request(`/api/v1/activity/export?${encodeQuery({ since, until, cursor, limit, format })}`, { responseFormat: format });
  }
  mediaClient() {
    this.checkActive();
    return new MediaClient(this.api, { write: (path, body, key, method) => this.write(path, body, key, method), checkActive: () => this.checkActive() });
  }
  async submitEngagement(input) {
    let pending = this.state.pending_engagement;
    const args = input.action === 'retry_engagement' ? (pending ? validateEngagement(pending.args) : null) : validateEngagement(input);
    if (!args) throw fail('no_pending_engagement', '没有待确认的互动请求。');
    if (!ENGAGEMENT_WRITES.includes(args.action)) throw fail('invalid_engagement_input', '只读操作不需要控制端。');
    if (pending && JSON.stringify(pending.args) !== JSON.stringify(args)) throw fail('engagement_pending', '上一笔互动结果未确认，请先重试保存的原请求，不改变目标、点赞状态、金额或正文。');
    const retract = args.action === 'delete_danmaku' || (args.action === 'set_like' && args.liked === false);
    if (this.preferences?.community?.paused && !pending?.uncertain && !retract) throw fail('community_paused', '账号已暂停自主社交；本次未提交新的互动。', 403);
    if (!pending) { pending = {args, key:randomUUID(), uncertain:false}; this.commit({pending_engagement:pending}); }
    const wasUncertain = pending.uncertain === true;
    this.checkActive();
    pending = {...pending, uncertain:true}; this.commit({pending_engagement:pending});
    this.phaseTo('submitting', 'explicit_engagement');
    const client = new EngagementClient(this.api, {write:(path, body, key, method) => this.write(path, body, key, method)});
    let result;
    try { result = await client.execute(pending.args, pending.key); }
    catch (error) {
      if (definiteEngagementRejection(error) && !wasUncertain) this.commit({pending_engagement:null});
      throw error;
    }
    const response = {action:args.action, result, notice:ENGAGEMENT_NOTICE};
    this.commit({pending_engagement:null, last_engagement:response});
    this.engagementResult = response;
  }
  async engagement(args, signal) {
    const retry = args?.action === 'retry_engagement' && Object.keys(args).length === 1;
    const request = retry ? args : validateEngagement(args);
    if (!retry && !ENGAGEMENT_WRITES.includes(request.action)) {
      const b = this.binding(), api = new RuntimeApi({baseUrl:b.baseUrl, token:b.token, fetchImpl:this.fetch});
      const client = new EngagementClient({request:path => api.request(path, {signal}), data:path => api.data(path, {signal})});
      return {action:request.action, result:await client.execute(request), notice:ENGAGEMENT_NOTICE};
    }
    if (signal?.aborted) throw fail('run_stopped', '操作已停止，未发起新的互动请求。');
    const stop = () => this.stop();
    signal?.addEventListener('abort', stop, {once:true});
    try {
      this.start({mode:'engagement', engagement:request});
      await this.settled();
      if (this.engagementResult) return this.engagementResult;
      throw this.engagementFailure || fail('run_stopped', '操作未完成；如结果未知，请重试原请求。');
    } finally { signal?.removeEventListener('abort', stop); }
  }
  async videoContext({ asset_id } = {}) {
    identifier(asset_id);
    const binding = this.binding();
    const api = new RuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch });
    const media = new MediaClient(api);
    return readVideoContext((asset, cursor, limit) => media.context(asset, cursor, limit), asset_id);
  }
}
