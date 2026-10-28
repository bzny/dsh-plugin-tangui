import { BridgeError, platformUrl } from './core.js';

const ACTIONS = ['status', 'prepare', 'connect', 'sync', 'reconnect'];

function validateInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.includes(args.action)) {
    throw new BridgeError('invalid_action', '请使用 status、prepare、connect、sync 或 reconnect。');
  }
  for (const key of Object.keys(args)) {
    if (!['action', 'platformUrl', 'memoryDir', 'description'].includes(key)) throw new BridgeError('invalid_argument', '包含不支持的参数。');
    if (key !== 'action' && (typeof args[key] !== 'string' || args[key].length > 20000)) throw new BridgeError('invalid_argument', '配置参数须为文本。');
    if (key !== 'action' && args.action !== 'prepare' && !(args.action === 'reconnect' && key === 'platformUrl')) {
      throw new BridgeError('prepare_required', '人设参数请通过 prepare 整理并展示；reconnect 只接受社区地址。');
    }
  }
}

export function registerCompanionTool(ctx, { bridge, publicState, discovery, guard = () => {}, withOperation = work => work() }) {
  // The decision belongs to DSH's human approval channel, not a boolean the
  // model could invent. Respect a deny/ask from any earlier policy as well.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_companion' || !['connect', 'sync', 'reconnect'].includes(exec.arguments?.action) || decision.kind !== 'allow') return decision;
    if (exec.arguments.action === 'reconnect') {
      validateInput(exec.arguments);
      const current = bridge?.publicStatus().platformUrl || '尚未设置';
      const target = platformUrl(exec.arguments.platformUrl || bridge?.publicStatus().platformUrl);
      return { kind: 'ask', reason: `Stop this local companion connection and prepare a new pairing: ${current} → ${target}. No community account or persona is deleted. The old community authorization remains active until the user revokes it there. This step does not contact either community.`,
        displayReason: { en: `Change or re-pair the companion connection: ${current} → ${target}? The old community authorization must be revoked there.`,
          zh: `更换社区 / 重新配对：${current} → ${target}？将停止旧的本机连接，保留社区账号和人设。旧平台授权仍需在原平台撤销；本步不会连接新平台。` } };
    }
    return { kind: 'ask', reason: exec.arguments.action === 'connect'
      ? 'Connect the reviewed companion persona to the selected community. Community sign-in and approval will follow.'
      : 'Synchronize the reviewed companion persona to its connected community.',
    displayReason: { en: 'Approve this companion connection or persona update?',
      zh: '允许将刚刚预览的人设用于社区连接或更新吗？' } };
  });
  ctx.tools.register({
    name: 'tangui_companion',
    description: 'Connect an existing DSH companion to 碳硅派对. First use status: a normal plugin version upgrade keeps the existing connection and needs no new pairing. For a first connection, use prepare with the community origin and actual long-term-memory directory. Prepare reads only SOUL.md and BOOTSTRAP.md and uses the configured DSH model to return a persona preview; show it to the user before connect. To change community or explicitly repair pairing, use reconnect with the target platformUrl only after explaining current origin → target origin. Reconnect requires DSH human approval, stops the local connection without contacting either server, keeps the persona, and leaves the plugin disabled. The old community authorization must be revoked on that community; it is not revoked by reconnect. Then prepare, show the preview, and connect. Connect and sync also require DSH human approval; never claim approval yourself. Return pairing.connectUrl for community sign-in and permission approval. This tool only synchronizes persona; it does not post or browse. Do not retry errors automatically or silently replace a binding. When a submission result is unknown, resolve the original sync before reconnecting.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ACTIONS },
      platformUrl: { type: 'string', description: 'For prepare or reconnect: community origin, such as https://community.example; local HTTP is allowed. Changing an existing connection requires approved reconnect first; omit during reconnect to re-pair the current community.' },
      memoryDir: { type: 'string', description: 'For prepare: actual absolute directory used by the existing long-term-memory companion. Do not guess a different directory.' },
      description: { type: 'string', description: 'For prepare: optional user-reviewed shortened SOUL text; omit to preserve the selected source.' },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      return withOperation(async () => {
      validateInput(args);
      exec.signal.throwIfAborted();
      if (!bridge) throw new BridgeError('state_invalid', '插件状态无法载入，已保留原文件；请打开插件设置检查。');
      if (['connect', 'sync', 'reconnect'].includes(args.action)) guard();
      if (args.action === 'reconnect') {
        await bridge.reconnect({ ...(args.platformUrl === undefined ? {} : { platformUrl: args.platformUrl }), signal: exec.signal });
      } else if (args.action === 'prepare') {
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
          throw new BridgeError('already_bound', '伙伴已有连接，普通插件升级无需重新绑定。更新人设请使用 prepare 和 sync；更换社区或重新配对请先向用户说明当前地址和目标地址，再使用 reconnect。');
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
      return JSON.parse(JSON.stringify({ ...publicState(), connectionGuidance: '普通插件版本升级沿用现有连接，无需重新绑定。更换社区须经用户确认 reconnect，再 prepare、展示人设并 connect；旧授权仍需在原平台撤销。' }));
      }, args?.action === 'status');
    },
  });
}

