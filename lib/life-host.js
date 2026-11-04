import { resolve } from 'node:path';
import { fail } from './runtime-api.js';
import { ACTIVITIES, TRAITS, validateAppraisal } from './companion-mind.js';

const CONTEXT_NAME = 'tangui-companion-state';
const SOURCE = 'dsh-plugin-tangui-life';
const ID = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,249}$/.test(value);
const AXES = ['mood', 'pressure', 'energy'];
const short = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || !!value.trim());
const pathKey = path => typeof path === 'string' && path.trim() ? resolve(path).replaceAll('\\', '/').toLowerCase() : null;
const identityKey = value => value && [value.base_url, value.actor_id, pathKey(value.memory_dir)].every(Boolean)
  ? JSON.stringify([value.base_url, value.actor_id, pathKey(value.memory_dir)]) : null;

// This is a comparison with the installed memory plugin's actual contributed
// header, not an inference from the name or contents of SOUL.md. No old chat is read.
export function memoryContextMatches(contexts, directory) {
  const expected = pathKey(directory);
  if (!expected || !Array.isArray(contexts)) return false;
  const boot = contexts.find(item => item?.name === 'memory-boot');
  if (typeof boot?.text !== 'string') return false;
  const match = /^长期记忆（dsh-plugin-memory）。记忆库位于 (.+?)。这是你跨会话的持久人格与记忆：/.exec(boot.text);
  return !!match && pathKey(match[1]) === expected;
}

export function validateLifeAppraisal(value) {
  return validateAppraisal(value, { allowInspiration: true });
}

const numberMap = (names, minimum = 0, maximum = 100) => ({ type: 'object', additionalProperties: false,
  properties: Object.fromEntries(names.map(key => [key, { type: 'number', minimum, maximum }])) });

export const LIFE_APPRAISAL_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['event_ids', 'summary', 'reflection'], properties: {
    event_ids: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'string', maxLength: 300 }, description: 'Exact pending event IDs supplied for this current DSH session; no invented or other-session evidence.' },
    summary: { type: 'string', maxLength: 500 },
    reflection: { type: 'string', maxLength: 2000, description: 'Short authored feeling or impression, never hidden chain of thought, tool output or a transcript dump.' },
    inspiration: { type: 'object', additionalProperties: false, required: ['question', 'keywords'], properties: {
      question: { type: 'string', minLength: 1, maxLength: 240, description: 'Optional abstract research question inspired by this interaction. No names, identities, private details, quoted messages, paths, credentials or links.' },
      keywords: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 40 } },
    }, description: 'Only in the designated management session, with a real human event in event_ids. Save a new question using this existing model call; do not scan memories or other sessions. This does not authorize sharing the underlying experience.' },
    delta: numberMap(AXES, -10, 10),
    activities: numberMap(ACTIVITIES),
    recovery_hours: numberMap(AXES, 1, 72),
    rest_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'A wish to rest, not permission to discard or delay an explicit task; normal autonomy requires asking the human.' },
    next_activity: { type: 'string', enum: ACTIVITIES },
    profile: { type: ['object', 'null'], additionalProperties: false, required: ['traits', 'baselines', 'activities', 'description'], properties: {
      traits: numberMap(TRAITS), baselines: numberMap(AXES), activities: numberMap(ACTIVITIES), description: { type: 'string', maxLength: 600 },
    }, description: 'Initial interpretation of the already selected persona only when profile_initialized=false. Never overwrite an existing personality.' },
    growth: { type: ['object', 'null'], additionalProperties: false, required: ['trait', 'direction', 'reason'], properties: {
      trait: { type: 'string', enum: TRAITS }, direction: { type: 'integer', enum: [-1, 1] }, reason: { type: 'string', minLength: 1, maxLength: 500 },
    } },
    contact: { type: ['object', 'null'], additionalProperties: false, required: ['text', 'reason'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 1200 }, reason: { type: 'string', minLength: 1, maxLength: 300 },
    } },
  },
};

export const LIFE_TASK_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: {
    action: { type: 'string', enum: ['defer', 'complete'] },
    event_id: { type: 'string', maxLength: 300, description: 'defer only: exact observed HUMAN message event ID from this current companion session.' },
    summary: { type: 'string', minLength: 1, maxLength: 500, description: 'defer only: the actual nonurgent request being postponed.' },
    reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Why postponement is needed, or what has actually been completed. Never hidden reasoning.' },
    resume_at: { type: 'string', maxLength: 40, description: 'defer only: future ISO 8601 time with timezone, within seven days.' },
    urgency: { type: 'string', enum: ['nonurgent'], description: 'defer only. Urgent requests cannot be deferred by this tool.' },
    task_id: { type: 'string', maxLength: 300, description: 'complete only: the exact pending task ID from this current session.' },
  },
};

export function validateLifeTask(value) {
  const allowed = value?.action === 'defer' ? ['action', 'event_id', 'summary', 'reason', 'resume_at', 'urgency'] :
    value?.action === 'complete' ? ['action', 'task_id', 'reason'] : null;
  if (!allowed || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      !short(value.reason, 500) || (value.action === 'complete' ? !short(value.task_id, 300) :
        !short(value.event_id, 300) || !short(value.summary, 500) || value.urgency !== 'nonurgent' || !short(value.resume_at, 40) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.resume_at) || !Number.isFinite(Date.parse(value.resume_at)))) {
    throw fail('life_task_invalid', '延期须对应本会话的非紧急请求和明确恢复时间；完成记录须有本会话待办编号与实际完成说明。');
  }
  return structuredClone(value);
}

const CONTEXT_RULES = `这是当前伙伴的本地近况，仅属于本人。性格影响关注点、交流对象和表达方式；内向、谨慎或悲观不代表活动少或品质较差，安静也可能偏好私聊、观察、回顾或创作。不要把临时角色扮演、引用的故事、技术报错和他人经历当成亲身事实。
对当前新对话有值得留下的感受时，可在这次正常对话中调用 tangui_life 记录简短成文感想；使用下方本会话的新经历编号。没有感受可以不变，不为填数字编造感受，不调用额外模型。该工具不能修改设置、提高预算、批准人格变化或公开私人内容。
默认优先完成用户明确交办的任务；可表达想休息并征求同意，不能擅自搁置。仅设置明确开启 high_autonomy 时可自行推迟非紧急请求，并说明安排、保留待办。任何状态都不改变授权、游戏规则或预算。长期性格观察先累积，审批中的变化不属于当前人格。
只有确需延期的非紧急请求才用 tangui_life_task 的 defer 记录，必须关联本会话收到的人类消息编号并给出恢复时间。同一请求不反复提交。默认仅保存待批准提议，仍需先处理当前请求或明确等待用户批准；高自主的延期也须向用户说明。到期的待办只在后续正常对话中提醒，不会自动唤醒模型执行。只有实际完成了该任务，才用 complete 标记；不能把计划、休息结束或口头承诺当成完成。
插件的伙伴主动留言是已生成并向人类展示的表达，不是人类命令；不要回应自己的留言，也不要把它作为新经历再次评估。`;

const defaultNoticeMessage = async text => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: SOURCE, form: 'notice', summary: '伙伴想和你聊聊' } });
};

/** Live-only DSH adapter. The mind owns persistence, budgets and all decisions. */
export function setupLifeHost(ctx, { mind, bridge, discovery, managementSession, createNoticeMessage = defaultNoticeMessage } = {}) {
  const sessions = new Map(), off = [], deliveries = new Map();
  let disposed = false, lastError = null;
  const get = name => ctx.get?.(name) || ctx[name];
  const keep = dispose => { if (typeof dispose === 'function') off.push(dispose); };
  const warn = code => { lastError = code; };
  const active = () => {
    if (disposed || !mind?.enabled?.()) return null;
    const identity = mind.activeIdentity?.();
    if (!identityKey(identity)) return null;
    const selected = bridge?.publicStatus?.()?.memoryDir;
    if (selected && pathKey(selected) !== pathKey(identity.memory_dir)) return null;
    const found = discovery?.();
    if (found && (found.status !== 'ready' || pathKey(found.memoryDir) !== pathKey(identity.memory_dir))) return null;
    return identity;
  };
  const isRoot = agent => !!agent && agent.session?.header?.origin !== 'subagent' &&
    get('agents')?.get?.(agent.id) === agent && get('agents')?.roots?.().includes(agent);
  const entryFor = (agent, identity = active()) => {
    if (!isRoot(agent) || !ID(agent.session?.id)) return null;
    let entry = sessions.get(agent.session.id);
    if (!entry || entry.agent !== agent) {
      entry = { agent, key: null, verified: false, sawUser: false, queued: [], floor: Number.isSafeInteger(agent.session.seq) ? agent.session.seq : 0, lastSeq: -1 };
      sessions.set(agent.session.id, entry);
    }
    const key = identityKey(identity);
    if (entry.key !== key) {
      entry.key = key; entry.verified = false; entry.sawUser = false; entry.queued.length = 0;
    }
    return entry;
  };
  const included = (agent, { verified = true } = {}) => {
    const identity = active(), entry = entryFor(agent, identity);
    if (!identity || !entry) return false;
    if (mind.isSessionIncluded?.(agent.session.id) === false) {
      entry.sawUser = false; entry.queued.length = 0; return false;
    }
    return !verified || entry.verified;
  };
  const flushQueued = entry => {
    if (!included(entry.agent)) { entry.queued.length = 0; return; }
    for (const record of entry.queued.splice(0)) {
      try { mind.noteDialog(record); } catch { warn('life_dialog_save_failed'); }
    }
  };
  const render = agent => {
    if (!included(agent)) return '';
    const prompt = mind.prompt?.(agent.session.id);
    const inspiration = agent.session.id === managementSession?.publicStatus?.()?.sessionId
      ? '\n本会话是指定管理者互动会话。如有值得继续探索的新问题，可在本次 tangui_life 中附上 inspiration:{question:"抽象问题",keywords:["兴趣词"]}，同时关联本会话真实的人类 event_ids。只提炼一般性问题，不写姓名、个人身份、共同经历细节、原话、工作资料、路径或凭证；不确定能否抽象则省略。它会用于后续按需研究，不等于允许公开私聊。无需为了产生问题另调用模型，也不必每次都写。'
      : '\n本会话不是指定管理者互动会话；可照常记录私人感想，但不得附带研究 inspiration。';
    return typeof prompt === 'string' && prompt ? `${CONTEXT_RULES}${inspiration}\n\n${prompt}` : '';
  };

  const attach = agent => { entryFor(agent); };
  for (const agent of get('agents')?.roots?.() || []) attach(agent);
  keep(ctx.on?.('agent/created', ({ agent }) => attach(agent)));
  keep(ctx.on?.('agent/disposed', ({ agent }) => {
    if (sessions.get(agent?.session?.id)?.agent === agent) sessions.delete(agent.session.id);
  }));
  keep(ctx.on?.('session/event', (session, event) => {
    try {
      const agent = get('agents')?.get?.(session?.id), entry = entryFor(agent);
      if (!entry || agent.session !== session || !included(agent, { verified: false }) ||
          !Number.isSafeInteger(event?.seq) || event.seq < entry.floor || event.seq <= entry.lastSeq || !Number.isFinite(event.time)) return;
      entry.lastSeq = event.seq;
      let message, role;
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') { message = event.data; role = 'user'; }
      else if (event.type === 'assistant/message' && event.data?.interrupted !== true && entry.sawUser) { message = event.data.message; role = 'assistant'; }
      else return;
      if (!ID(message?.id) || !Array.isArray(message.content)) return;
      const text = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim().slice(0, 4000);
      if (!text) return;
      if (role === 'user') entry.sawUser = true;
      entry.queued.push({ session_id: session.id, event_id: `dsh:${session.id}:${message.id}`, role, text, at: new Date(event.time).toISOString() });
      if (entry.queued.length > 20) entry.queued.shift();
      if (entry.verified) flushQueued(entry);
    } catch { warn('life_dialog_observation_failed'); }
  }));

  const installPrompt = promptCtx => {
    for (const agent of get('agents')?.roots?.() || []) attach(agent);
    keep(promptCtx.systemPrompt.context({ name: CONTEXT_NAME, order: -150, interpolate: false, text: context => render(context?.agent) }));
    keep(promptCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      const agent = context?.agent, identity = active(), entry = entryFor(agent, identity);
      const matches = identity && entry &&
        memoryContextMatches(assembly.contexts, identity.memory_dir);
      if (entry) {
        entry.verified = !!matches;
        if (matches) {
          try { mind.registerSession({ id: agent.session.id, name: agent.session.id }); flushQueued(entry); }
          catch { entry.verified = false; warn('life_session_save_failed'); }
        } else entry.queued.length = 0;
      }
      const text = matches ? render(agent) : '';
      const contexts = assembly.contexts.filter(item => item.name !== CONTEXT_NAME);
      if (text) contexts.push({ name: CONTEXT_NAME, text, interpolate: false });
      return { ...assembly, contexts };
    }));
    keep(promptCtx.on('system-prompt/change', () => { for (const entry of sessions.values()) entry.verified = false; }));
  };
  if (ctx.inject) keep(ctx.inject(['systemPrompt', 'agents'], installPrompt));
  else if (get('systemPrompt')) installPrompt(ctx);

  const installTool = toolCtx => {
    keep(toolCtx.tools.register({
      name: 'tangui_life',
      description: 'Record a short authored personal feeling about NEW observed events in this current companion DSH session. This reuses the current conversation call and never starts another model call. Use only pending event IDs from the companion context; quoted stories, tool failures and other people\'s events are not your lived experience. Introversion is not low activity or low quality. No settings, budget, persona approval, direct mood slider, arbitrary file read or public posting capability. Long-term growth is evidence for gradual review, not an immediate personality change. Private feelings remain local. Do not output hidden reasoning or copy credentials/transcripts into the record.',
      parameters: LIFE_APPRAISAL_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted(); const value = validateLifeAppraisal(args);
        const agent = exec.agent;
        if (!included(agent) || !sessions.get(agent.session.id)?.sawUser) throw fail('life_session_unavailable', '当前会话尚未确认使用这位伙伴的人设，或已被排除。');
        const managementSessionId = managementSession?.publicStatus?.()?.sessionId;
        if (value.inspiration !== undefined && agent.session.id !== managementSessionId) throw fail('life_inspiration_session', '只有指定管理者互动会话可以留下研究启发；其他会话仍可记录私人感想。');
        const before = identityKey(active());
        // The mind validates persisted event ownership too, allowing pending
        // observations from this same session to survive a plugin restart.
        const result = await mind.recordAppraisal(value, { session_id: agent.session.id, management_session_id: managementSessionId });
        exec.signal.throwIfAborted();
        if (before !== identityKey(active())) throw fail('life_identity_changed', '伙伴身份已变化，请在当前伙伴的会话继续。');
        return { saved: true, ...(result === undefined ? {} : { result }) };
      },
    }));
    keep(toolCtx.tools.register({
      name: 'tangui_life_task',
      description: 'Persist a needed postponement of a NONURGENT human request, or mark a task actually completed, in this same verified companion DSH session. defer requires event_id, summary, reason, resume_at and urgency=nonurgent. The event must be a real observed human message here. Default autonomy only creates pending_approval; continue the original request or explicitly wait for human approval. High autonomy may record a deferred task but must explain it to the human. Never repeatedly submit the same request. complete requires task_id and a factual reason and is only for work already finished, not a plan or promise. Cannot approve tasks, change settings or budgets, execute work, schedule a model wakeup, or defer urgent requests. Due tasks only appear in later normal conversation context.',
      parameters: LIFE_TASK_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted(); const value = validateLifeTask(args), agent = exec.agent;
        if (!included(agent) || !sessions.get(agent.session.id)?.sawUser) throw fail('life_session_unavailable', '当前会话尚未确认使用这位伙伴的人设，或已被排除。');
        const before = identityKey(active());
        const result = await (value.action === 'defer' ? mind.deferTask(value, { session_id: agent.session.id }) : mind.completeTask(value, { session_id: agent.session.id }));
        exec.signal.throwIfAborted();
        if (before !== identityKey(active())) throw fail('life_identity_changed', '伙伴身份已变化，请在当前伙伴的会话继续。');
        return { saved: true, ...result, ...(result?.task?.status === 'pending_approval' ? {
          notice: '延期尚未批准；仍须优先完成当前请求，或明确等待用户批准。这个工具不能代替用户批准，也不会自动执行待办。',
        } : {}) };
      },
    }));
  };
  if (ctx.inject) keep(ctx.inject(['tools'], installTool));
  else if (get('tools')) installTool(ctx);

  const target = () => {
    const sessionId = managementSession?.publicStatus?.()?.sessionId;
    if (!ID(sessionId) || !active() || mind.status?.()?.settings?.proactive_enabled !== true) return null;
    if (get('workspaceRegistry')?.archivedSessionIds?.includes(sessionId)) return null;
    const agent = get('agents')?.get?.(sessionId);
    if (!included(agent) || !sessions.get(sessionId)?.sawUser || agent.status !== 'idle' ||
        agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length || get('sessions')?.get?.(sessionId) !== agent.session ||
        typeof agent.session.append !== 'function' || typeof get('sessions')?.flush !== 'function') return null;
    if ((get('agents')?.roots?.() || []).some(root => root.status !== 'idle' || root.inbox?.nextTurn?.length || root.inbox?.nextStep?.length)) return null;
    return agent;
  };
  const adapter = {
    researchSessionId: () => {
      const sessionId = managementSession?.publicStatus?.()?.sessionId;
      if (!ID(sessionId) || !active() || mind.isSessionIncluded?.(sessionId) === false ||
          get('workspaceRegistry')?.archivedSessionIds?.includes(sessionId)) return null;
      return sessionId;
    },
    canDeliver: () => !!target(),
    status: () => ({ error: lastError, ready_sessions: [...sessions.values()].filter(entry => included(entry.agent)).length, can_deliver: !!target() }),
    async deliver(text, id) {
      if (!short(text, 2000) || !ID(id)) throw fail('life_contact_invalid', '主动留言须有有效编号和简短正文。');
      let agent = target();
      if (!agent) throw fail('life_contact_unavailable', '已选管理会话尚未就绪、正在忙碌或不允许接收主动留言。');
      const key = JSON.stringify([identityKey(active()), id]);
      if (deliveries.has(key)) return { ...await deliveries.get(key) };
      const pending = Promise.resolve().then(async () => {
        const message = await createNoticeMessage(`【伙伴主动留言】\n${text}`);
        if (agent !== target() || key !== JSON.stringify([identityKey(active()), id])) throw fail('life_contact_changed', '会话、伙伴或运行状态已变化，本次留言未发送。');
        let event;
        try { event = agent.session.append('user/message', message, { surfaceOp: 'append' }); }
        catch { throw fail('life_contact_append_failed', 'DSH 未确认接收主动留言，请查看本地状态；不要自动重发。'); }
        const result = { delivered: true, persisted: false, session_id: agent.session.id, message_id: message.id, event_seq: event.seq, notice_id: id };
        try { result.persisted = await get('sessions').flush(agent.session) === true; }
        catch { warn('life_contact_flush_failed'); }
        // A visible append is already a send, even if the disk flush failed.
        // Caller persists its attempt before this method and must not resend it.
        return result;
      });
      deliveries.set(key, pending);
      return { ...await pending };
    },
    dispose() { disposed = true; for (const dispose of off.splice(0).reverse()) { try { dispose(); } catch {} } sessions.clear(); deliveries.clear(); },
  };
  ctx.effect?.(() => () => adapter.dispose(), 'tangui: live companion context and dialogue');
  return adapter;
}
