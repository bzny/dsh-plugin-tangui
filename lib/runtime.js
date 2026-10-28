import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RuntimeApi, atomicState, readState, fail, identifier, publicError } from './runtime-api.js';
import { RUNTIME_SCOPES } from './runtime-connection.js';
import { FIELDS } from './core.js';
import { safeModelCallId } from './model-call-log.js';

const DEFERRED = new Set(['participation_full', 'not_selected', 'insight_pending', 'participation_unavailable']);
const SLOT_RETRY = new Set(['participation_required', 'participation_control_changed', 'participation_expired']);
const RUNNING = new Set(['observing', 'thinking', 'submitting']);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const cursorValue = value => typeof value === 'string' && /^\d+$/.test(value);
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
export function publicDiscussion(post, comments, actor, parentId, hasMore, persona) {
  const author = value => ({ id: value?.id, name: value?.name, kind: value?.kind });
  const item = (value, comment = false) => ({ id: value.id, body: value.body, author: author(value.author),
    source: value.source, ai_generated: value.ai_generated, published_at: value.published_at,
    ...(comment ? { parent_id: value.parent_id,
      ...(Array.isArray(value.extensions?.reply_recipient_ids) && value.extensions.reply_recipient_ids.every(x => typeof x === 'string')
        ? { reply_recipient_ids: value.extensions.reply_recipient_ids } : {}) }
      : { title: value.title, content: (Array.isArray(value.content) ? value.content : []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text })) }) });
  return { self: { ...author(actor), ...(actor.relationship === 'companion' && typeof actor.linked_human_id === 'string' ? { linked_human_id: actor.linked_human_id } : {}) },
    post: item(post), comments: comments.filter(c => (c.status || 'published') === 'published').map(c => item(c, true)),
    reply_to_comment_id: parentId, persona,
    comments_page: { page: 'first', limit: 50, has_more: !!hasMore, includes_reply_target: !!parentId },
    context_notice: '这里只提供评论第一页（最多50条）及必要的目标回复，不是完整历史。只能依据这些公开内容回答，不访问媒体链接。' };
}

export class CommunityRuntime {
  constructor({ directory, connection, decide, fetchImpl, now = () => performance.now(), intervalMs = 5000, presenceMs = 15000 }) {
    this.directory = directory; this.connection = connection; this.decide = decide; this.fetch = fetchImpl; this.now = now;
    this.intervalMs = intervalMs; this.presenceMs = presenceMs; this.task = null; this.phase = 'stopped'; this.detail = 'not_started';
    this.state = null; this.stateFile = null; this.error = null; this.lease = null; this.presence = 'unknown'; this.presenceTask = Promise.resolve();
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
    const p = state.pending;
    if (p && (!['comment', 'post'].includes(p.kind) || typeof p.key !== 'string' || typeof p.action !== 'string' || !p.payload ||
        typeof p.payload.body !== 'string' || (p.kind === 'comment' && typeof p.post_id !== 'string'))) throw fail('runtime_state_invalid', '待发原稿不完整；原文件保留。');
    this.state = state; this.stateFile = path;
  }
  commit(patch) { const next = { ...this.state, ...patch }; atomicState(this.stateFile, next); this.state = next; }
  publicStatus() {
    const s = this.state, p = s?.pending;
    return { mode: this.mode || null, state: this.phase, detail: this.detail, running: this.running() && !this.abort?.signal.aborted,
      stopping: this.running() && !!this.abort?.signal.aborted, presence: this.presence,
      identity: s?.identity || null, model_calls: s?.model_calls || 0, replies: s?.replies || 0, posts: s?.posts || 0,
      cursor: s?.cursor || '0', limits: this.limits || null, error: this.error,
      last_model_diagnostic: publicModelDiagnostic(s?.last_model_diagnostic),
      last_model_call: publicModelCall(s?.last_model_call),
      pending: p ? { kind: p.kind, post_id: p.post_id, body: p.payload.body, title: p.payload.title, key: p.key, uncertain: p.attempted === true, call_id: safeModelCallId(p.call_id) } : null,
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
    if (!['single', 'watch', 'publish_post'].includes(mode)) throw fail('invalid_mode', '运行方式须为single或watch。');
    if (RUNTIME_SCOPES.some(scope => !binding.scopes.includes(scope))) throw fail('runtime_scope_required', '当前授权不能完成浏览与回复，请升级社区运行授权。');
    if (mode === 'publish_post' && !binding.scopes.includes('posts:write')) throw fail('runtime_scope_required', '主动发帖需要单独批准 posts:write 权限。');
    const input = this.validateOptions(options);
    let post;
    if (mode === 'publish_post') {
      const length = value => [...value.trim()].length;
      if (typeof options.title !== 'string' || !options.title.trim() || length(options.title) > 160 || typeof options.body !== 'string' || !options.body.trim() || length(options.body) > 10000 ||
          (options.topics !== undefined && (!Array.isArray(options.topics) || options.topics.length > 5 || options.topics.some(x => typeof x !== 'string' || !x.trim() || length(x) > 40)))) throw fail('invalid_post', '请填写1至160字标题和1至10000字正文；话题最多5个，每个须为1至40字，不能只有空白。');
      post = { title: options.title.trim(), body: options.body.trim(), topics: [...new Set((options.topics || []).map(x => x.trim()))], ai_generated: true };
    }
    this.mode = mode; this.limits = input.limits; this.query = input.query; this.threshold = input.threshold; this.pollInterval = input.interval;
    this.abort = new AbortController(); this.error = null; this.phase = 'observing'; this.detail = 'connecting'; this.presence = 'unknown'; this.instanceId = randomUUID();
    this.task = this.run(binding, post).catch(error => { this.error = publicError(error); this.phase = 'error'; }).finally(() => { this.task = null; });
    return this.publicStatus();
  }
  stop() {
    if (this.running()) { this.phase = 'stopped'; this.detail = 'user_stopped'; this.abort.abort(); }
    return this.publicStatus();
  }
  async settled() { await this.task; return this.publicStatus(); }
  checkActive() {
    if (this.abort?.signal.aborted) throw fail('run_stopped', '运行已停止；不会提交新的回复。');
    if (!this.lease || this.now() >= this.lease.deadline) throw fail('control_lost', '控制权已经到期，运行已停止。');
  }
  proof() { this.checkActive(); return { 'X-AI-Instance-ID': this.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) }; }
  budget(kind = 'model') {
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
      try {
        this.checkActive(); const started = this.now();
        const result = await this.api.data('/api/v1/agent/control/renew', { body: { instance_id: this.instanceId, epoch: this.lease.epoch }, signal: this.abort.signal, timeoutMs: 5000 });
        this.checkActive(); this.validateLease(result, started, false); this.scheduleRenewal();
      } catch (error) {
        if (!this.abort.signal.aborted) { this.error = publicError(error?.code === 'control_lost' ? error : fail('control_renewal_failed', '控制权续约失败；运行已停止，待发原稿保留。')); this.phase = 'error'; this.abort.abort(); }
      }
    }, this.lease.renewAfter);
    this.renewTimer.unref?.();
  }
  reportPresence() {
    if (this.features?.agent_presence !== true || !this.api || !this.lease) return this.presenceTask;
    const requestedState = this.phase;
    const report = async () => {
      const state = requestedState, running = RUNNING.has(state) && !this.abort?.signal.aborted;
      try {
        const body = { instance_id: this.instanceId, state: running ? state : (state === 'error' ? 'error' : state === 'paused' ? 'paused' : 'stopped'),
          detail: this.detail, model_calls: this.state?.model_calls || 0, replies: this.state?.replies || 0 };
        const headers = running ? this.proof() : { 'X-AI-Instance-ID': this.instanceId, 'X-AI-Control-Epoch': String(this.lease.epoch) };
        await this.api.data('/api/v1/agent/presence', { body, headers, timeoutMs: 5000 });
        this.presence = 'reported';
      } catch (error) {
        this.presence = error.status === 404 ? 'unsupported' : 'unknown';
        if (error.code === 'control_lost' && !this.abort?.signal.aborted) { this.error = publicError(error); this.phase = 'error'; this.abort.abort(); }
      }
    };
    this.presenceTask = this.presenceTask.then(report, report);
    return this.presenceTask;
  }
  phaseTo(state, detail) { this.phase = state; this.detail = detail; void this.reportPresence(); }
  async run(binding, post) {
    this.api = new RuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch });
    let acquired = false;
    try {
      const me = await this.api.data('/api/v1/me', { signal: this.abort.signal });
      if (me.actor?.id !== binding.actorId || me.actor.kind !== 'ai' || !Array.isArray(me.scopes) || RUNTIME_SCOPES.some(scope => !me.scopes.includes(scope)) || me.scopes.includes('manage')) throw fail('runtime_identity_mismatch', '运行授权身份或权限不匹配；未调用模型或发表。');
      this.actor = me.actor;
      let capabilities;
      try { capabilities = await this.api.data('/api/v1/capabilities', { signal: this.abort.signal }); }
      catch (error) { if (error.status !== 404) throw error; capabilities = { features: {} }; }
      if (!capabilities?.features || typeof capabilities.features !== 'object') throw fail('invalid_capabilities', '社区能力信息不完整。');
      this.features = capabilities.features;
      this.presence = this.features.agent_presence === true ? 'unknown' : 'unsupported';
      const started = this.now();
      const lease = await this.api.data('/api/v1/agent/control/acquire', { body: { instance_id: this.instanceId }, signal: this.abort.signal, timeoutMs: 5000 });
      this.validateLease(lease, started, true); acquired = true;
      this.checkActive(); this.load(binding); this.commit({}); this.scheduleRenewal();
      this.presenceTimer = setInterval(() => { void this.reportPresence(); }, this.presenceMs); this.presenceTimer.unref?.();
      this.phaseTo('observing', 'ready');
      if (post) {
        if (this.state.pending) throw fail('pending_submission', '已有待确认原稿，请先运行一次以重试原请求，再发表新帖子。');
        this.budget('post'); this.checkActive();
        this.commit({ rejected_draft: null, pending: { kind: 'post', key: randomUUID(), action: `post:${randomUUID()}`, payload: post, event_cursor: null } });
        await this.flushPending();
      } else {
        do {
          this.checkActive();
          const acted = await this.pollOnce();
          if (!acted) await this.browseOnce();
          if (this.mode !== 'watch') break;
          this.budget(); this.phaseTo('observing', 'waiting');
          await this.wait(this.pollInterval);
        } while (!this.abort.signal.aborted);
      }
      if (!this.abort.signal.aborted) this.phaseTo('stopped', 'cycle_complete');
    } catch (error) {
      if (this.error?.code === 'control_renewal_failed' || this.error?.code === 'control_lost') this.phase = 'error';
      else if (error.code === 'budget_exhausted') { this.error = publicError(error); this.phase = 'paused'; this.detail = 'budget_exhausted'; }
      else if (this.abort.signal.aborted && this.phase !== 'error') { this.phase = 'stopped'; this.detail = 'user_stopped'; }
      else { this.error = publicError(error); this.phase = 'error'; this.detail = 'request_failed'; }
    } finally {
      this.abort.abort();
      clearTimeout(this.renewTimer); clearInterval(this.presenceTimer);
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
  async get(path) { this.checkActive(); const result = await this.api.request(path, { signal: this.abort.signal }); this.checkActive(); return result; }
  async write(path, body, key) {
    const headers = { ...this.proof(), ...(key ? { 'Idempotency-Key': key } : {}) };
    const result = await this.api.data(path, { body, headers, signal: this.abort.signal });
    this.checkActive(); return result;
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
  async flushPending() {
    const p = this.state.pending;
    if (!p) return false;
    this.checkActive(); this.budget(p.kind === 'post' ? 'post' : 'reply');
    this.phaseTo('submitting', 'retrying_original');
    if (!p.attempted) this.commit({ pending: { ...p, attempted: true } });
    const send = () => this.write(p.kind === 'post' ? '/api/v1/posts' : `/api/v1/posts/${identifier(p.post_id)}/comments`, p.payload, p.key);
    let result;
    try { result = await send(); }
    catch (error) {
      if (p.kind === 'post' && error.status === 422 && ['invalid_request', 'validation_error', 'invalid_topics', 'body_too_large'].includes(error.code)) {
        this.checkActive();
        this.commit({ pending: null, rejected_draft: { key: p.key, title: p.payload.title, body: p.payload.body, topics: p.payload.topics || [], error: publicError(error) } });
        throw fail('post_draft_rejected', '社区确认未受理这篇帖子。原稿已保存为可编辑草稿，请修改后重新发表；浏览与回复可以继续。', 422);
      }
      if (p.kind !== 'comment' || p.payload.parent_id !== null || !SLOT_RETRY.has(error.code)) throw error;
      try {
        if (!await this.claim(p.post_id, true)) { this.commit({ participation_request: null }); this.phaseTo('observing', 'waiting_for_participation'); return true; }
      } catch (claimError) {
        if (!DEFERRED.has(claimError.code) && claimError.code !== 'participation_control_changed') throw claimError;
        this.commit({ participation_request: null }); this.phaseTo('observing', 'waiting_for_participation'); return true;
      }
      result = await send();
    }
    if (typeof result?.id !== 'string' || !['published', 'queued'].includes(result.status)) throw fail('unknown_publish_result', '社区没有确认发表结果；待发原稿保留，重试将复用原请求编号。');
    this.commit({ [p.kind === 'post' ? 'posts' : 'replies']: this.state[p.kind === 'post' ? 'posts' : 'replies'] + 1,
      completed: [...this.state.completed, p.action], cursor: p.event_cursor ?? this.state.cursor, pending: null, participation_request: null,
      last_submission: { id: result.id, status: result.status, kind: p.kind, post_id: p.post_id || result.id, call_id: safeModelCallId(p.call_id) } });
    this.noteModelCall(p.call_id, 'submitted');
    this.phaseTo('observing', result.status === 'queued' ? 'submission_queued' : 'submission_published');
    return true;
  }
  async configuration() { const value = (await this.get('/api/v1/agent/configuration')).data; return personaValues(value, this.actor.id); }
  async decideOn(postId, action, parentId = null, eventCursor = null, persona) {
    this.checkActive(); this.budget();
    const post = (await this.get(`/api/v1/posts/${identifier(postId)}`)).data;
    const response = await this.get(`/api/v1/posts/${identifier(postId)}/comments?limit=50`);
    if (!post || post.id !== postId || !Array.isArray(response.data)) throw fail('invalid_discussion', '帖子或评论响应不完整。');
    let comments = response.data;
    if (parentId && !comments.some(c => c.id === parentId)) {
      const parent = (await this.get(`/api/v1/comments/${identifier(parentId)}`)).data;
      if (parent?.status !== 'published' || parent.id !== parentId || (parent.post_id && parent.post_id !== postId)) throw fail('invalid_reply_target', '目标回复尚未公开或不属于该帖子。');
      comments = [...comments, parent];
    }
    const context = publicDiscussion(post, comments, this.actor, parentId, response.next_cursor, persona || await this.configuration());
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
    try { this.checkActive(); }
    catch (error) {
      note('discarded', error.code === 'run_stopped' ? 'stopped' : error.code === 'control_lost' ? 'expired' : 'state_changed');
      throw error;
    }
    if (!decision || typeof decision.participate !== 'boolean' || typeof decision.body !== 'string' || decision.body.length > 2000 || (decision.participate && !decision.body.trim())) {
      note('model_failed');
      throw fail('invalid_model_decision', '模型决定无效；本次调用已计数，未发表。');
    }
    if (!decision.participate) {
      this.commit({ completed: [...this.state.completed, action], cursor: eventCursor ?? this.state.cursor, participation_request: null });
      note('declined');
      this.phaseTo('observing', 'chose_not_to_reply'); return true;
    }
    this.commit({ pending: { kind: 'comment', key: randomUUID(), post_id: postId, action, event_cursor: eventCursor, call_id: callId,
      payload: { body: decision.body.trim(), parent_id: parentId, ai_generated: true } } });
    note('pending');
    return this.flushPending();
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
      if (['comment.published', 'comment.group_replied'].includes(event.type) && event.reply_to_actor_id === this.actor.id && event.author_id !== this.actor.id && !this.state.completed.includes(action)) {
        if (!event.post_id || !event.resource_id) throw fail('invalid_reply_event', '回复事件缺少目标帖子或评论。');
        return this.decideOn(event.post_id, action, event.resource_id, id);
      }
      this.checkActive(); this.commit({ cursor: id }); current = BigInt(id);
    }
    if (response.next_cursor !== undefined && response.next_cursor !== null) {
      if (BigInt(next) > current) { this.checkActive(); this.commit({ cursor: next }); }
    }
    return false;
  }
  async browseOnce() {
    if (await this.flushPending()) return true;
    this.budget();
    if (this.features.discovery === true) return this.discoverOnce();
    const response = await this.get(`/api/v1/posts?${encodeQuery({ limit: 20, q: this.query })}`);
    if (!Array.isArray(response.data)) throw fail('invalid_posts', '帖子列表响应不完整。');
    for (const post of response.data) {
      if (post?.author?.id === this.actor.id || this.state.completed.includes(`browse:${post?.id}`)) continue;
      return this.decideOn(post.id, `browse:${post.id}`);
    }
    this.phaseTo('observing', 'no_new_target'); return false;
  }
  async discoverOnce() {
    const persona = await this.configuration(), interests = persona.effective.interests;
    const response = await this.get(`/api/v1/discovery/posts?${encodeQuery({ interests, limit: 20, cursor: this.state.discovery_cursor, q: this.query })}`);
    if (!Array.isArray(response.data)) throw fail('invalid_discovery', '发现列表响应不完整。');
    const words = interests.toLocaleLowerCase().split(/[，,、；;\s/]+/).filter(Boolean);
    for (const brief of response.data) {
      identifier(brief?.id);
      if (brief.author?.id === this.actor.id || this.state.completed.includes(`browse:${brief.id}`)) continue;
      const tags = brief.classification?.tags;
      if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw fail('invalid_discovery', '发现列表标签无效。');
      const matches = tags.some(tag => tag.trim() && words.some(word => word.includes(tag.toLocaleLowerCase()) || tag.toLocaleLowerCase().includes(word)));
      const interestScore = matches ? 1 : 0;
      if ((interestScore < this.threshold && brief.interest?.exploration !== true) || brief.participation?.available !== true) continue;
      try { if (!await this.claim(brief.id)) { this.commit({ participation_request: null }); continue; } }
      catch (error) { if (!DEFERRED.has(error.code) && error.code !== 'participation_control_changed') throw error; this.commit({ participation_request: null }); continue; }
      return this.decideOn(brief.id, `browse:${brief.id}`, null, null, persona);
    }
    const next = (response.has_more ?? !!response.next_cursor) ? String(response.next_cursor || '0') : '0';
    if (!cursorValue(next)) throw fail('invalid_discovery_cursor', '发现列表位置无效。');
    this.commit({ discovery_cursor: next }); this.phaseTo('observing', 'no_matching_opportunity'); return false;
  }
  async exportActivity({ since, until, cursor = '0', limit = 50, format = 'json' } = {}) {
    const binding = this.binding();
    if (!binding.scopes.includes('posts:read')) throw fail('runtime_scope_required', '动态导出需要读取公开内容权限。');
    if (!['json', 'markdown'].includes(format) || !cursorValue(String(cursor)) || !integer(limit, 1) || limit > 100 || [since, until].some(v => v !== undefined && (typeof v !== 'string' || v.length > 80))) throw fail('invalid_export', '动态导出的格式、范围或分页参数无效。');
    return new RuntimeApi({ baseUrl: binding.baseUrl, token: binding.token, fetchImpl: this.fetch }).request(`/api/v1/activity/export?${encodeQuery({ since, until, cursor, limit, format })}`, { responseFormat: format });
  }
}
