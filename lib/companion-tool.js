import { BridgeError } from './core.js';

const ACTIONS = ['status', 'prepare', 'connect', 'sync'];

function validateInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.includes(args.action)) {
    throw new BridgeError('invalid_action', '请使用 status、prepare、connect 或 sync。');
  }
  for (const key of Object.keys(args)) {
    if (!['action', 'platformUrl', 'memoryDir', 'description'].includes(key)) throw new BridgeError('invalid_argument', '包含不支持的参数。');
    if (key !== 'action' && (typeof args[key] !== 'string' || args[key].length > 20000)) throw new BridgeError('invalid_argument', '配置参数须为文本。');
    if (key !== 'action' && args.action !== 'prepare') throw new BridgeError('prepare_required', '请先用 prepare 整理并展示修改后的资料。');
  }
}

export function registerCompanionTool(ctx, { bridge, publicState, discovery }) {
  // The decision belongs to DSH's human approval channel, not a boolean the
  // model could invent. Respect a deny/ask from any earlier policy as well.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_companion' || !['connect', 'sync'].includes(exec.arguments?.action) || decision.kind !== 'allow') return decision;
    return { kind: 'ask', reason: exec.arguments.action === 'connect'
      ? 'Connect the reviewed companion persona to the selected community. Community sign-in and approval will follow.'
      : 'Synchronize the reviewed companion persona to its connected community.',
    displayReason: { en: 'Approve this companion connection or persona update?',
      zh: '允许将刚刚预览的人设用于社区连接或更新吗？' } };
  });
  ctx.tools.register({
    name: 'tangui_companion',
    description: 'Connect an existing DSH companion to 碳硅派对. First use status, then prepare with the community origin and the actual long-term-memory directory. Prepare reads only SOUL.md and BOOTSTRAP.md and uses the configured DSH model to return a persona preview. Show that preview to the user before connect. Connect and sync require DSH human approval; never claim approval yourself. Return pairing.connectUrl to the user for community sign-in and permission approval. This tool only synchronizes persona; it does not post or browse the community. Do not retry errors automatically or silently replace an existing binding.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ACTIONS },
      platformUrl: { type: 'string', description: 'For prepare: community origin, such as https://community.example; local HTTP is allowed.' },
      memoryDir: { type: 'string', description: 'For prepare: actual absolute directory used by the existing long-term-memory companion. Do not guess a different directory.' },
      description: { type: 'string', description: 'For prepare: optional user-reviewed shortened SOUL text; omit to preserve the selected source.' },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      validateInput(args);
      exec.signal.throwIfAborted();
      if (!bridge) throw new BridgeError('state_invalid', '插件状态无法载入，已保留原文件；请打开插件设置检查。');
      if (args.action === 'prepare') {
        let memoryDir = args.memoryDir || bridge.publicStatus().memoryDir;
        if (!memoryDir) {
          const found = discovery();
          if (found.status !== 'ready') throw new BridgeError('memory_dir_required', '请先从已有长期记忆配置确认实际目录，或打开 DSH 的碳硅派对设置自动识别；不要猜测目录。');
          memoryDir = found.memoryDir;
        }
        await bridge.prepare({ ...args, memoryDir, signal: exec.signal });
      } else if (args.action === 'connect' || args.action === 'sync') {
        const state = bridge.publicStatus();
        if (args.action === 'connect' && state.binding) {
          throw new BridgeError('already_bound', '伙伴已有连接；请查看状态，需要更新人设时使用 prepare 和 sync。');
        }
        if (state.pendingImport && args.action === 'sync') {
          await bridge.sync({ signal: exec.signal });
        } else {
          if (state.normalization.status !== 'ready' || state.normalization.changed) throw new BridgeError('prepare_required', '请先 prepare 整理当前人设，并向用户展示预览。');
          if (args.action === 'connect') await bridge.configure({ enabled: true, signal: exec.signal });
          else {
            if (!state.binding) throw new BridgeError('not_bound', '请先 connect，并在社区网页完成批准。');
            await bridge.sync({ fresh: true, signal: exec.signal });
          }
        }
      }
      exec.signal.throwIfAborted();
      // JSON normalization excludes optional undefined fields and guarantees
      // that no private bridge fields can leak through the tool return value.
      return JSON.parse(JSON.stringify(publicState()));
    },
  });
}
