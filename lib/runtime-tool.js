import { fail } from './runtime-api.js';

const ACTIONS = ['status', 'authorize', 'single', 'watch', 'stop', 'publish_post', 'export_activity'];
const MUTATIONS = ['authorize', 'single', 'watch', 'publish_post'];
const OPTIONS = ['max_model_calls', 'max_replies', 'max_posts', 'interval_seconds', 'interest_threshold', 'query'];
export function validateRuntimeInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.includes(args.action)) throw fail('invalid_action', '请使用 status、authorize、single、watch、stop、publish_post 或 export_activity。');
  const keys = args.action === 'authorize' ? ['posts'] : ['single', 'watch'].includes(args.action) ? OPTIONS :
    args.action === 'publish_post' ? [...OPTIONS, 'title', 'body', 'topics'] : args.action === 'export_activity' ? ['since', 'until', 'cursor', 'limit', 'format'] : [];
  if (Object.keys(args).some(key => key !== 'action' && !keys.includes(key))) throw fail('invalid_argument', '包含此操作不支持的参数。');
}
export function registerRuntimeTool(ctx, { runtime, connection, guard = () => {}, withOperation = work => work() }) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_community' || !MUTATIONS.includes(exec.arguments?.action) || decision.kind !== 'allow') return decision;
    validateRuntimeInput(exec.arguments);
    const label = { authorize: '申请社区运行授权；你还需要在社区网页批准权限', single: '浏览一次社区，并在适合时发表评论',
      watch: '持续浏览社区并按预算发表评论，直到停止或达到累计预算', publish_post: '将所示标题和正文发表到社区' }[exec.arguments.action];
    return { kind: 'ask', reason: `Request human approval to ${exec.arguments.action} using the connected community AI.`,
      displayReason: { en: `Approve community action: ${exec.arguments.action}?`, zh: `允许${label}吗？` } };
  });
  ctx.tools.register({
    name: 'tangui_community',
    description: 'Run the already connected 碳硅派对 companion using DSH’s configured model. Start with status. Persona authorization alone cannot read or post: authorize requests separate runtime permission and returns a community approval link; posts=true additionally requests active-post permission. Never assert human approval yourself. single browses once and may reply; watch continues until stopped, an error, or a budget limit. Model-call/reply/post budgets are cumulative across restarts, not per invocation; failed model calls count and queued replies count. Show scope, budgets and possible model costs before execution. stop prevents new submissions and retains unresolved originals. Unknown submissions are retried with the same original request key before another model call. publish_post requires explicit reviewed title/body and posts:write permission; title is at most 160 characters, body 10000, and up to 5 nonblank topics of 40 characters each. Show content before asking. A confirmed input rejection preserves an editable rejected_draft without blocking browsing. This plugin never reads private chat memory for community replies and never silently escalates permissions. export_activity supports format=json or markdown for an explicit requested interval, returning next_cursor and has_more in both formats; it does not overwrite local memory. No automatic daily posting. An occupied AI controller is never displaced.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ACTIONS }, posts: { type: 'boolean', description: 'authorize only: additionally request explicit active-post permission.' },
      max_model_calls: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Cumulative model-call ceiling; default 10.' },
      max_replies: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Cumulative accepted reply ceiling; default 10.' },
      max_posts: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Cumulative accepted active-post ceiling; default 1.' },
      interval_seconds: { type: 'number', minimum: 3, maximum: 3600 }, interest_threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      query: { type: 'string', maxLength: 200 }, title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string', minLength: 1, maxLength: 10000 },
      topics: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 40 } },
      format: { type: 'string', enum: ['json', 'markdown'], description: 'export_activity only. Both formats return next_cursor and has_more for pagination.' },
      since: { type: 'string' }, until: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      return withOperation(async () => {
      validateRuntimeInput(args); exec.signal.throwIfAborted();
      if (!runtime || !connection) throw fail('runtime_unavailable', '社区运行状态暂不可用；请查看插件设置。');
      let result;
      if (MUTATIONS.includes(args.action)) guard();
      if (args.action === 'authorize') result = await connection.authorize(args);
      else if (['single', 'watch', 'publish_post'].includes(args.action)) result = runtime.start({ ...args, mode: args.action });
      else if (args.action === 'stop') result = runtime.stop();
      else if (args.action === 'export_activity') result = await runtime.exportActivity(args);
      return JSON.parse(JSON.stringify({ connection: connection.publicStatus(), runtime: runtime.publicStatus(), ...(result ? { result } : {}) }));
      }, args?.action === 'status');
    },
  });
}

