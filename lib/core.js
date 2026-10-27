import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const LIMIT = 64 * 1024;
export const FIELDS = ['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'];
const labels = {
  role: ['角色', '角色定位', '定位'], manager_address: ['对管理者的称呼', '管理者称呼'],
  speaking_style: ['沟通风格', '说话风格', '语气'], interests: ['兴趣', '兴趣爱好'],
  participation_style: ['参与方式', '互动方式'], boundaries: ['边界'], memory_notes: ['公开记忆备注', '平台记忆备注'],
};
const fingerprint = (text) => createHash('sha256').update(text).digest('hex');
const cleanLine = (value) => value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '').trim();

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function platformUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('invalid_platform', '请输入有效的平台地址。'); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new BridgeError('invalid_platform', '请输入社区首页地址；远程社区须使用 HTTPS，本机可使用 HTTP。地址不能包含账号密码、页面路径或查询参数。');
  }
  return url.origin;
}

function readCapped(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > LIMIT) throw new BridgeError('memory_file_invalid', '人设文件须为普通文本，且不能超过 64 KB。');
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

// This adapter deliberately reads exactly these two files. It never traverses
// the memory directory or follows profile/index references inside SOUL.md.
export function readSoul(memoryDir) {
  if (!isAbsolute(memoryDir)) throw new BridgeError('invalid_memory_dir', '记忆目录必须是绝对路径。');
  const bootstrap = readCapped(join(memoryDir, 'BOOTSTRAP.md'));
  const soul = readCapped(join(memoryDir, 'SOUL.md'));
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bootstrap || '')?.[1] || '';
  const completed = /^status:\s*["']?complete["']?\s*$/m.test(frontmatter);
  const complete = completed && !!soul?.trim() && !soul.includes('（铸魂对话中确认）');
  const description = soul || '';
  const lines = description.split(/\r?\n/).map(cleanLine);
  const field = (names) => {
    for (const line of lines) {
      const match = /^([^：:]{1,30})[：:]\s*(.+)$/.exec(line);
      if (match && names.includes(match[1].trim())) return match[2].trim();
    }
    return null;
  };
  const overrides = Object.fromEntries(FIELDS.map((key) => [key, field(labels[key])]));
  if (!overrides.manager_address) {
    const addressing = field(['相互称呼']);
    const explicit = addressing && /我(?:叫|称呼)(?:用户|管理者|你)(?:为)?\s*[「“"']([^」”"']{1,80})[」”"']/.exec(addressing);
    if (explicit) overrides.manager_address = explicit[1];
  }
  // Exact section text is evidence too; no model calls or inferred personality.
  const sections = [...description.matchAll(/^##\s+([^\r\n]+)\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)];
  for (const [key, names] of Object.entries(labels)) {
    if (overrides[key]) continue;
    const section = sections.find((match) => names.includes(match[1].trim()));
    const value = section?.[2].trim();
    if (value && value.length <= 4000) overrides[key] = value;
  }
  return { complete, sourceHash: fingerprint(description), reason: complete ? '铸魂完成' : '等待 BOOTSTRAP 标记 complete，且 SOUL 已填写',
    draft: { name: field(['名字', '姓名', '名称']) || '', description, overrides } };
}

function validateDraft(value) {
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 40) throw new BridgeError('invalid_name', '请填写 1 至 40 字的 AI 名字。');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 20000) throw new BridgeError('invalid_persona', '平台人设说明须为 1 至 20000 字。');
  const overrides = {};
  for (const key of FIELDS) {
    const input = value.overrides?.[key];
    if (input != null && (typeof input !== 'string' || input.length > 4000)) throw new BridgeError('invalid_field', '单项人设属性不能超过 4000 字。');
    overrides[key] = typeof input === 'string' && input.trim() ? input.trim() : null;
  }
  return { name: value.name.trim(), description: value.description, overrides };
}

export class RegistrationBridge {
  constructor({ stateFile, memoryDir, baseUrl = '', fetchImpl = fetch, normalizePersona, timeoutMs = 12000, now = Date.now }) {
    this.stateFile = stateFile;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.normalizePersona = normalizePersona;
    this.activeNormalization = null;
    this.busy = false;
    this.error = null;
    this.warning = null;
    this.state = { version: 1, enabled: false, memoryDir: memoryDir || '', baseUrl: baseUrl ? platformUrl(baseUrl) : '', instanceId: randomUUID(), status: 'disabled' };
    if (existsSync(stateFile)) {
      let saved;
      try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { throw new BridgeError('state_invalid', '插件状态文件无法读取；未覆盖原文件。'); }
      if (saved.version !== 1 || (saved.memoryDir !== '' && (typeof saved.memoryDir !== 'string' || !isAbsolute(saved.memoryDir)))) throw new BridgeError('state_invalid', '插件状态版本或目录无效；未覆盖原文件。');
      this.state = { ...this.state, ...saved, baseUrl: saved.baseUrl ? platformUrl(saved.baseUrl) : '' };
      if (!this.state.baseUrl && (this.state.enabled || this.state.binding || this.state.pair)) throw new BridgeError('state_invalid', '已启用或绑定的插件缺少平台地址；未覆盖原文件。');
      if (this.state.status === 'redeeming') this.state.status = 'reconnect_required';
      if (this.state.normalization?.status === 'running') {
        this.state.normalization.status = 'error';
        this.state.normalization.code = 'normalization_interrupted';
        if (!this.state.binding && !this.state.pending) this.state.status = 'error';
      }
    }
    // A persisted identity belongs to the account; a controller instance is
    // unique to this running process. Restarting must not impersonate an old
    // process that may still hold a valid lease.
    this.state.instanceId = randomUUID();
    this.resumeImport = !!this.state.binding && (!!this.state.pending || !Number.isSafeInteger(this.state.binding.revision));
  }

  save() {
    mkdirSync(join(this.stateFile, '..'), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  source() {
    if (!this.state.memoryDir) return { complete: false, sourceHash: fingerprint(''), reason: '请先选择长期记忆目录',
      draft: { name: '', description: '', overrides: Object.fromEntries(FIELDS.map((field) => [field, null])) } };
    return readSoul(this.state.memoryDir);
  }
  draft() {
    const source = this.source();
    if (this.state.draft) return this.state.draft;
    // Labels remain useful for reading the source, but are never a production
    // substitute for AI normalization. Do not fabricate a ready draft here.
    return { name: '', description: this.state.selectedDescription ?? source.draft.description,
      overrides: Object.fromEntries(FIELDS.map((field) => [field, null])) };
  }

  publicStatus() {
    let source, draft;
    try { source = this.source(); draft = this.draft(); } catch (error) { this.error = { code: error.code || 'source_error', message: error.message }; }
    const pair = this.state.pair;
    const binding = this.state.binding;
    const normalized = this.state.normalization;
    return { enabled: this.state.enabled, platformUrl: this.state.baseUrl, memoryDir: this.state.memoryDir,
      status: this.state.status, busy: this.busy, sourceComplete: source?.complete || false, sourceReason: source?.reason,
      sourceDescription: source?.draft.description || '',
      draft: draft && { name: draft.name, description: draft.description, overrides: draft.overrides },
      normalization: { status: normalized?.status || 'unprepared', model: normalized?.model || '',
        evidence: normalized?.evidence || {}, sourceHash: normalized?.sourceHash || null, inputHash: normalized?.inputHash || null,
        changed: !!normalized && (normalized.sourceHash !== source?.sourceHash ||
          normalized.inputHash !== fingerprint(this.state.selectedDescription ?? source?.draft.description ?? '')),
        ...(normalized?.code ? { code: normalized.code } : {}) },
      changed: !!binding && source?.sourceHash !== this.state.importedSourceHash,
      pairing: pair && { userCode: pair.userCode, expiresAt: pair.expiresAt,
        connectUrl: `${this.state.baseUrl}/connect/dsh?code=${encodeURIComponent(pair.userCode)}&name=${encodeURIComponent(this.state.draft?.name || '')}` },
      binding: binding && { actorId: binding.actorId, actorName: binding.actorName || '', grantId: binding.grantId, revision: binding.revision ?? null },
      pendingImport: !!this.state.pending, pendingUncertain: this.state.pending?.stage === 'attempted', error: this.error, warning: this.warning };
  }

  normalizationInput(input = {}) {
    const memoryDir = input.memoryDir || this.state.memoryDir;
    if (!memoryDir) throw new BridgeError('memory_dir_required', '请先选择长期记忆目录，再整理人设。');
    const sourceChanged = memoryDir !== this.state.memoryDir;
    const baseUrl = platformUrl(input.platformUrl || this.state.baseUrl);
    if ((this.state.binding || this.state.pair) && baseUrl !== this.state.baseUrl) {
      throw new BridgeError('bound_platform', '已有配对或绑定时不能更换平台，请先重新连接。');
    }
    const source = readSoul(memoryDir);
    // A previously reviewed, shortened description stays selected even if
    // SOUL later changes. Never silently send the unshortened source instead.
    const description = Object.hasOwn(input, 'description') ? input.description :
      (sourceChanged ? source.draft.description : (this.state.selectedDescription ?? source.draft.description));
    if (typeof description !== 'string' || !description.trim() || description.length > 20000) {
      throw new BridgeError('invalid_persona', '待整理的人设说明须为 1 至 20000 字。');
    }
    return { memoryDir, baseUrl, source, sourceChanged, description, inputHash: fingerprint(description) };
  }

  async prepare(input = {}) {
    if (this.activeNormalization) {
      const current = this.normalizationInput(input);
      const active = this.activeNormalization;
      if (current.memoryDir === active.memoryDir && current.baseUrl === active.baseUrl &&
          current.source.sourceHash === active.sourceHash && current.inputHash === active.inputHash && !active.invalidated) {
        await active.promise;
        return this.publicStatus();
      }
      active.invalidated = true;
      throw new BridgeError('normalization_changed_while_running', '整理过程中输入已变化，旧结果将丢弃；请等待本次结束后重新整理。', 409);
    }
    return this.exclusive(async () => {
      await this.prepareDraft(input);
      if (this.state.binding && Number.isSafeInteger(this.state.binding.revision) && !this.state.pending) this.state.status = 'bound';
      else if (!this.state.binding) this.state.status = this.state.enabled ? 'prepared' : 'disabled';
      this.save();
      return this.publicStatus();
    }, input.signal);
  }

  async prepareDraft(input = {}) {
    if (this.state.pending?.stage === 'attempted') {
      throw new BridgeError('pending_result_unknown', '上一笔人设提交的结果尚未确认。请先重试原同步请求，确认结果后才能整理新内容。', 409);
    }
    const candidate = this.normalizationInput(input);
    const { memoryDir, baseUrl, source, sourceChanged, description, inputHash } = candidate;
    if (!source.complete) throw new BridgeError('soul_incomplete', '铸魂尚未完成，暂不整理或上传。');
    if (sourceChanged) {
      delete this.state.selectedDescription; delete this.state.draft; delete this.state.normalization;
    }
    this.state.memoryDir = memoryDir;
    this.state.baseUrl = baseUrl;
    if (Object.hasOwn(input, 'description')) this.state.selectedDescription = description;
    const cached = this.state.normalization;
    if (cached?.status === 'ready' && cached.sourceHash === source.sourceHash && cached.inputHash === inputHash &&
        this.state.draft?.sourceHash === source.sourceHash && this.state.draft?.inputHash === inputHash) {
      return this.state.draft;
    }
    const active = { memoryDir, baseUrl, sourceHash: source.sourceHash, inputHash, invalidated: false };
    this.activeNormalization = active;
    this.state.normalization = { status: 'running', sourceHash: source.sourceHash, inputHash };
    this.save();
    active.promise = (async () => {
      try {
        if (typeof this.normalizePersona !== 'function') throw new BridgeError('normalizer_unavailable', 'AI 人设整理服务尚未连接，请先配置 DSH 模型。');
        let result;
        try { result = await this.normalizePersona({ description }, this.operationSignal); }
        catch (error) {
          const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'normalization_failed';
          const messages = {
            normalization_empty_output: '模型结束了请求，但没有返回人设正文；请检查该模型的输出设置后手动重试。',
            normalization_json_invalid: '模型返回的正文不是有效 JSON；未提交平台，请手动重试或检查模型。',
            normalization_timeout: '模型整理超时；未提交平台，也不会自动重试。',
            normalization_evidence_invalid: '模型的属性依据与原文不符；未提交平台，请核对人设后手动重试。',
            normalization_name_missing: '人设中没有可核对的 AI 名字；请补充后重新整理。',
          };
          const wrapped = new BridgeError(code, messages[code] || 'AI 人设整理失败或资料依据不足；尚未注册或上传，请检查模型设置和人设说明后手动重试。');
          const diagnostic = {};
          for (const key of ['textChars', 'reasoningChars', 'textBlocks', 'reasoningBlocks']) {
            const value = error?.diagnostic?.[key];
            if (Number.isSafeInteger(value) && value >= 0 && value <= 1000000) diagnostic[key] = value;
          }
          if (typeof error?.diagnostic?.wholeJsonFence === 'boolean') diagnostic.wholeJsonFence = error.diagnostic.wholeJsonFence;
          if (['stop', 'max-tokens', 'tool-calls', 'unknown', 'none'].includes(error?.diagnostic?.finishKind)) diagnostic.finishKind = error.diagnostic.finishKind;
          if (Object.keys(diagnostic).length) wrapped.diagnostic = diagnostic;
          throw wrapped;
        }
        this.operationSignal?.throwIfAborted();
        const latest = this.source();
        if (active.invalidated || this.state.memoryDir !== memoryDir || this.state.baseUrl !== baseUrl ||
            !latest.complete || latest.sourceHash !== source.sourceHash ||
            fingerprint(this.state.selectedDescription ?? latest.draft.description) !== inputHash) {
          throw new BridgeError('normalization_stale', '整理过程中人设来源或输入已变化，旧结果已丢弃，请重新整理。', 409);
        }
        if (!result || result.description !== description) throw new BridgeError('normalization_invalid', 'AI 整理结果改变了原文，未采用该结果。');
        const draft = validateDraft(result);
        const model = result.normalization?.model;
        const evidence = {};
        if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new BridgeError('normalization_invalid', 'AI 整理结果缺少有效模型信息，未采用该结果。');
        for (const field of ['name', ...FIELDS]) {
          const value = field === 'name' ? draft.name : draft.overrides[field];
          const quote = result.normalization?.evidence?.[field];
          if (value != null && (typeof quote !== 'string' || !quote.trim() || quote.length > 800 || !description.includes(quote))) {
            throw new BridgeError('normalization_evidence_invalid', 'AI 整理出的属性缺少可核对的原文依据，未采用该结果。');
          }
          evidence[field] = value == null ? null : quote;
        }
        this.state.draft = { ...draft, sourceHash: source.sourceHash, inputHash, method: 'ai' };
        this.state.normalization = { status: 'ready', model: model.trim(), evidence, sourceHash: source.sourceHash, inputHash };
        this.save();
        return this.state.draft;
      } catch (error) {
        this.state.normalization = { status: 'error', sourceHash: source.sourceHash, inputHash, code: error.code || 'normalization_failed',
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
        this.save();
        throw error;
      } finally { if (this.activeNormalization === active) this.activeNormalization = null; }
    })();
    return active.promise;
  }

  async request(path, { body, token, headers = {} } = {}) {
    const origin = platformUrl(this.state.baseUrl);
    if (typeof path !== 'string' || !/^\/api\/v1\/[a-z0-9/_-]+$/.test(path)) throw new BridgeError('invalid_endpoint', '平台接口路径无效。');
    let response;
    try {
      response = await this.fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: this.operationSignal
          ? AbortSignal.any([this.operationSignal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch { throw new BridgeError('network_error', '平台连接失败或超时，请确认社区地址和服务状态。', 503); }
    let value;
    try { value = await response.json(); } catch { throw new BridgeError('unsupported_platform', '平台未返回兼容的 JSON；请确认地址和后端版本。', 502); }
    if (!response.ok) {
      // Do not forward arbitrary upstream text that could echo bearer tokens.
      const known = { authorization_pending: '等待平台管理者批准。', control_busy: '此 AI 正由其他控制端运行，请结束该控制端后重试；插件不会抢占。',
        configuration_conflict: '平台人设版本已变化，请核对后重新提交更新。', control_lost: '控制权已失效，请重试本次同步。',
        pairing_expired: '配对已过期或已领取；请重新连接，并在平台撤销旧授权。', insufficient_scope: '此授权没有人设同步权限，请重新配对。',
        unauthorized: '插件授权已失效，请重新配对。' };
      const reported = value?.error?.code;
      const code = Object.hasOwn(known, reported) || ['persona_actor_mismatch', 'idempotency_conflict', 'forbidden', 'not_found', 'rate_limited'].includes(reported)
        ? reported : 'platform_error';
      throw new BridgeError(code, known[code] || `平台拒绝了请求（${response.status}，${code}）。`, response.status);
    }
    if (!value || !Object.hasOwn(value, 'data')) throw new BridgeError('unsupported_platform', '平台接口缺少 data 响应，当前版本不兼容。', 502);
    return value.data;
  }

  async exclusive(action, signal) {
    if (this.busy) throw new BridgeError('busy', '正在处理上一项操作，请稍候。', 409);
    this.busy = true;
    this.operationSignal = signal;
    this.error = null;
    try { signal?.throwIfAborted(); return await action(); }
    catch (error) {
      this.error = { code: error.code || 'operation_failed', message: error instanceof BridgeError ? error.message : '本地状态保存或处理失败；未确认同步成功。' };
      if (this.state.status !== 'reconnect_required') this.state.status = error.code === 'control_busy' ? 'control_busy' : 'error';
      try { this.save(); } catch { /* Preserve the last valid state; never print credentials. */ }
      throw error;
    } finally { this.busy = false; this.operationSignal = undefined; }
  }

  async configure(input) {
    return this.exclusive(async () => {
      if (input.enabled === false && !input.draft && !input.platformUrl && !input.memoryDir) {
        this.state.enabled = false; this.state.status = 'disabled'; this.save(); return this.publicStatus();
      }
      const address = input.platformUrl || this.state.baseUrl;
      const nextUrl = (address || input.enabled === true) ? platformUrl(address) : '';
      if ((this.state.binding || this.state.pair) && nextUrl !== this.state.baseUrl) throw new BridgeError('bound_platform', '已有配对或绑定时不能更换平台，请先重新连接。');
      const memoryDir = input.memoryDir || this.state.memoryDir;
      if (memoryDir && !isAbsolute(memoryDir)) throw new BridgeError('invalid_memory_dir', '记忆目录必须是绝对路径。');
      const sourceChanged = memoryDir !== this.state.memoryDir;
      if (sourceChanged && this.state.pending?.stage === 'attempted') throw new BridgeError('pending_result_unknown', '上一笔提交结果未确认，暂不能更换记忆来源，请先重试原同步请求。', 409);
      const enabled = input.enabled === true;
      // Legacy UI may send a draft. Its description is reviewed input only;
      // its name/attributes cannot bypass AI normalization on first connect.
      const suppliedDescription = Object.hasOwn(input, 'description') ? input.description : input.draft?.description;
      if (suppliedDescription !== undefined) {
        if (typeof suppliedDescription !== 'string' || !suppliedDescription.trim() || suppliedDescription.length > 20000) {
          throw new BridgeError('invalid_persona', '待整理的人设说明须为 1 至 20000 字。');
        }
        if (this.state.pending?.stage === 'attempted') throw new BridgeError('pending_result_unknown', '上一笔提交结果未确认，请先重试原同步请求。', 409);
        if (!memoryDir || !readSoul(memoryDir).complete) {
          throw new BridgeError('soul_incomplete', '铸魂尚未完成，请完成后重新核对要提交的人设说明；本次说明未保存。');
        }
      }
      if (sourceChanged) {
        delete this.state.selectedDescription; delete this.state.draft; delete this.state.normalization;
      }
      if (suppliedDescription !== undefined) this.state.selectedDescription = suppliedDescription;
      this.state.memoryDir = memoryDir;
      this.state.baseUrl = nextUrl;
      this.state.enabled = enabled;
      if (!enabled) this.state.status = 'disabled';
      else if (!this.state.binding) this.state.status = 'waiting_soul';
      else if (this.state.pending || !Number.isSafeInteger(this.state.binding.revision)) {
        if (!['error', 'control_busy'].includes(this.state.status)) this.state.status = 'bound_pending_import';
      } else this.state.status = 'bound';
      this.save();
      if (enabled && !memoryDir) throw new BridgeError('memory_dir_required', '请先选择长期记忆目录，再启用接入。');
      if (enabled && !this.state.binding) {
        if (this.source().complete) await this.prepareDraft();
        await this.progress();
      }
      return this.publicStatus();
    }, input.signal);
  }

  async tick() {
    if (this.busy || !this.state.enabled) return;
    if (this.resumeImport) {
      this.resumeImport = false;
      try { await this.exclusive(() => this.importPersona(false)); } catch { /* Settings show the exact state. */ }
      return;
    }
    if (this.state.binding || ['reconnect_required', 'error', 'prepared'].includes(this.state.status)) return;
    try { await this.exclusive(() => this.progress()); } catch { /* Visible in settings; no secret-bearing logs. */ }
  }

  async progress() {
    const source = this.source();
    if (!source.complete) {
      if (this.state.status !== 'waiting_soul') { this.state.status = 'waiting_soul'; this.save(); }
      return;
    }
    if (!this.state.pair) {
      if (this.state.status === 'reconnect_required') return;
      await this.prepareDraft();
      const result = await this.request('/api/v1/pairings', { body: { label: '碳硅派对 DSH 人设同步' } });
      if (typeof result.device_code !== 'string' || typeof result.user_code !== 'string') throw new BridgeError('unsupported_platform', '配对响应不完整。');
      this.state.pair = { deviceCode: result.device_code, userCode: result.user_code, expiresAt: this.now() + Number(result.expires_in || 600) * 1000,
        nextPoll: this.now() + Math.max(5, Number(result.interval) || 5) * 1000 };
      this.state.status = 'awaiting_approval';
      this.save();
      return;
    }
    if (this.state.pair.expiresAt <= this.now()) {
      this.state.status = 'reconnect_required'; this.save();
      throw new BridgeError('pairing_expired', '配对已过期，请重新连接；若已批准但未成功领取，请在平台撤销旧授权。');
    }
    if (this.state.pair.nextPoll > this.now()) return;
    // A crash after sending redemption can mean the one-shot response was
    // lost. On restart we require a new pairing instead of silently minting.
    this.state.status = 'redeeming';
    this.save();
    let result;
    try { result = await this.request('/api/v1/pairings/token', { body: { device_code: this.state.pair.deviceCode } }); }
    catch (error) {
      if (error.code === 'authorization_pending') {
        this.state.status = 'awaiting_approval'; this.state.pair.nextPoll = this.now() + 5000; this.save(); return;
      }
      this.state.status = 'reconnect_required'; this.save();
      throw new BridgeError('reconnect_required', '未确认授权领取结果。请重新连接，并在平台撤销本次旧授权；插件不会假报绑定成功。');
    }
    if (!result.token || !result.actor_id || !result.grant_id) {
      this.state.status = 'reconnect_required'; this.save();
      throw new BridgeError('reconnect_required', '授权返回不完整，请重新配对并撤销旧授权。');
    }
    this.state.binding = { token: result.token, actorId: result.actor_id, grantId: result.grant_id };
    delete this.state.pair;
    this.state.status = 'bound_pending_import';
    this.save();
    await this.importPersona(false);
  }

  async importPersona(fresh) {
    const binding = this.state.binding;
    if (!binding) throw new BridgeError('not_bound', '请先完成平台注册或绑定。');
    if (fresh && this.state.pending?.stage === 'attempted') {
      throw new BridgeError('pending_result_unknown', '上一笔人设提交的结果尚未确认。请先重试原同步请求，确认结果后才能提交新内容。', 409);
    }
    const me = await this.request('/api/v1/me', { token: binding.token });
    if (me.actor?.id !== binding.actorId || me.actor.kind !== 'ai') throw new BridgeError('identity_mismatch', '授权身份与所绑定 AI 不一致，已停止同步。');
    if (me.scopes?.length !== 1 || me.scopes[0] !== 'persona:write') throw new BridgeError('scope_mismatch', '本插件只接受“人设同步”授权。请在平台重新配对，仅勾选该权限。');
    binding.actorName = me.actor.name;
    if (fresh || !this.state.pending) {
      const source = this.source();
      if (!source.complete) throw new BridgeError('soul_incomplete', '铸魂尚未完成，未上传。');
      if (!this.state.draft) throw new BridgeError('normalization_required', '请先使用 AI 整理人设，再提交平台。');
      if (fresh && this.state.draft.sourceHash !== source.sourceHash) throw new BridgeError('normalization_stale', '人设来源已变化，请重新整理并核对后提交。', 409);
      if (fresh && this.state.draft.inputHash && this.state.draft.inputHash !== fingerprint(this.state.selectedDescription ?? source.draft.description)) {
        throw new BridgeError('normalization_stale', '待提交说明与已整理草稿不一致，请重新整理并核对后提交。', 409);
      }
      const draft = validateDraft(this.state.draft);
      const configuration = await this.request('/api/v1/agent/configuration', { token: binding.token });
      if (configuration.actor?.id !== binding.actorId || !Number.isSafeInteger(configuration.revision)) throw new BridgeError('unsupported_platform', '平台配置身份或版本无效。');
      this.state.pending = { key: randomUUID(), sourceHash: this.state.draft?.sourceHash || source.sourceHash, stage: 'prepared',
        body: { format: 'carbon-silicon.persona.v1', actor_id: binding.actorId, expected_revision: configuration.revision,
          description: draft.description, overrides: draft.overrides } };
      this.save();
    }
    const pending = this.state.pending;
    if (pending.stage !== 'attempted') {
      await this.request('/api/v1/agent/persona/preview', { body: pending.body, token: binding.token });
      pending.stage = 'previewed'; this.save();
    }
    const lease = await this.request('/api/v1/agent/control/acquire', { body: { instance_id: this.state.instanceId }, token: binding.token });
    if (!lease.active || !lease.owned_by_current_grant || !Number.isSafeInteger(lease.epoch)) throw new BridgeError('control_invalid', '未获得有效控制权，未提交人设。');
    try {
      pending.stage = 'attempted'; this.state.status = 'importing'; this.save();
      let result;
      try {
        result = await this.request('/api/v1/agent/persona/import', { body: pending.body, token: binding.token,
          headers: { 'Idempotency-Key': pending.key, 'X-AI-Instance-ID': this.state.instanceId, 'X-AI-Control-Epoch': String(lease.epoch) } });
      } catch (error) {
        if (['configuration_conflict', 'persona_actor_mismatch', 'idempotency_conflict', 'control_lost', 'forbidden', 'unauthorized'].includes(error.code)) {
          pending.stage = 'rejected'; this.save();
        }
        throw error;
      }
      if (!Number.isSafeInteger(result.revision)) throw new BridgeError('import_unconfirmed', '平台未返回有效人设版本，保留本次请求以便重试。');
      binding.revision = result.revision;
      this.state.importedSourceHash = pending.sourceHash;
      this.state.status = 'bound'; delete this.state.pending; this.save();
    } finally {
      try { await this.request('/api/v1/agent/control/release', { body: { instance_id: this.state.instanceId, epoch: lease.epoch }, token: binding.token }); }
      catch { this.warning = '控制权释放结果未确认；租期到期后自动失效。'; }
    }
  }

  async sync(input = {}) {
    return this.exclusive(async () => {
      if (!this.state.enabled) throw new BridgeError('disabled', '请先启用插件接入。');
      if ((input.fresh || input.draft) && this.state.pending?.stage === 'attempted') {
        throw new BridgeError('pending_result_unknown', '上一笔人设提交的结果尚未确认。请先重试原同步请求，确认结果后才能提交新内容。', 409);
      }
      if (input.draft && !this.state.binding) throw new BridgeError('normalization_required', '首次连接请先使用 AI 整理人设，再批准绑定。');
      if (input.draft) {
        const draft = validateDraft(input.draft);
        this.state.draft = { ...draft, sourceHash: this.source().sourceHash, inputHash: fingerprint(draft.description), method: 'manual' };
        this.state.selectedDescription = draft.description;
      }
      if (this.state.binding && !input.fresh && !this.state.pending && this.state.status === 'bound') {
        const me = await this.request('/api/v1/me', { token: this.state.binding.token });
        if (me.actor?.id !== this.state.binding.actorId || me.actor.kind !== 'ai') throw new BridgeError('identity_mismatch', '平台身份与绑定不一致，未修改人设。');
      } else if (this.state.binding) await this.importPersona(input.fresh === true);
      else await this.progress();
      return this.publicStatus();
    }, input.signal);
  }

  async reconnect() {
    return this.exclusive(async () => {
      delete this.state.binding; delete this.state.pair; delete this.state.pending; delete this.state.importedSourceHash;
      this.state.status = this.state.enabled ? 'waiting_soul' : 'disabled'; this.save();
      if (this.state.enabled) await this.progress();
      return this.publicStatus();
    });
  }
}
