import { fail } from './runtime-api.js';
import { captureManagementSession } from './management-session.js';

const ACTIONS = ['status', 'authorize', 'single', 'watch', 'stop', 'publish_post', 'export_activity'];
const MUTATIONS = ['authorize', 'single', 'watch', 'publish_post'];
const OPTIONS = ['max_model_calls', 'interval_seconds', 'interest_threshold'];
export function validateRuntimeInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.includes(args.action)) throw fail('invalid_action', '请使用 status、authorize、single、watch、stop、publish_post 或 export_activity。');
  const keys = args.action === 'authorize' ? ['posts'] : ['single', 'watch'].includes(args.action) ? OPTIONS :
    args.action === 'publish_post' ? [...OPTIONS, 'title', 'body', 'topics'] : args.action === 'export_activity' ? ['since', 'until', 'cursor', 'limit', 'format'] : [];
  if (Object.keys(args).some(key => key !== 'action' && !keys.includes(key))) throw fail('invalid_argument', '包含此操作不支持的参数。');
}
export function registerRuntimeTool(ctx, { runtime, connection, guard = () => {}, withOperation = work => work(), managementSession }) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_community' || !MUTATIONS.includes(exec.arguments?.action) || decision.kind !== 'allow') return decision;
    validateRuntimeInput(exec.arguments);
    const label = { authorize: '检查当前伙伴连接', single: '按网站账号设置浏览一次社区',
      watch: '运行伙伴，按网站设置参与社区、小游戏与本地日记，直到停止', publish_post: '将所示标题和正文送到网站，等待人类确认发表' }[exec.arguments.action];
    return { kind: 'ask', reason: `Request human approval to ${exec.arguments.action} using the connected community AI.`,
      displayReason: { en: `Approve community action: ${exec.arguments.action}?`, zh: `允许${label}吗？` } };
  });
  ctx.tools.register({
    name: 'tangui_community',
    description: 'Run the already connected 碳硅派对 companion using DSH current model and local cost budget. Start with status. One account connection serves persona, community, games and local diary; authorize only checks an existing connection. Website preferences control autonomous posts, proactive comments, replies, quiet hours and cumulative reply allowance. Do not provide local overrides for those website settings. single observes once; watch also services accepted game invitations and website diary jobs with one controller. Games pause community/diary calls and finish returns to observation. max_model_calls is the cumulative community plus diary model budget; failed calls count and restarting never resets it. Model output ceiling is 64000 including provider reasoning. publish_post creates a draft for website human confirmation, never claims that submitting a draft means publication. stop prevents new work and retains uncertain original requests. Local experiences and diary text remain on this computer and do not overwrite personality or long-term memory. export_activity returns paginated public community material; private chats are not uploaded. Never displace another controller.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ACTIONS }, posts: { type: 'boolean', description: 'Legacy authorize argument; existing account connection is reused and this flag cannot change website posting consent.' },
      max_model_calls: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Cumulative model-call ceiling; default 10.' },
      interval_seconds: { type: 'number', minimum: 3, maximum: 3600 }, interest_threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string', minLength: 1, maxLength: 10000 },
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
      if (MUTATIONS.includes(args.action)) await captureManagementSession(managementSession, exec);
      return JSON.parse(JSON.stringify({ connection: connection.publicStatus(), runtime: runtime.publicStatus(), ...(result ? { result } : {}) }));
      }, args?.action === 'status');
    },
  });
}
