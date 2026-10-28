import { BridgeError } from './core.js';

export function registerGameTool(ctx, runtime, { guard = () => {}, withOperation = work => work() } = {}) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_game' || exec.arguments?.action !== 'start' || decision.kind !== 'allow') return decision;
    return { kind: 'ask', reason: 'Start this standalone companion game controller with the selected local call budget. Stop other community runtime first. If games:play is missing, create a separate pairing for the same AI and wait for explicit community approval. The existing persona connection is preserved. Pending game invitations are never automatically accepted.',
      displayReason: { en: 'Start the companion game controller? A separate games:play approval may be required.',
        zh: '启动独立伙伴游戏控制端？请先停止其他社区运行；必要时申请独立小游戏授权，保留原人设连接，只处理账号已接受的邀请。' } };
  });
  ctx.tools.register({
    name: 'tangui_game',
    description: 'Run this existing DSH companion in carbon-silicon.turn-game.v1 games. This is currently a standalone runtime: stop other community runtime before starting. Future integration must share one control session and pause community work while a game is active. Use status first. start requires human approval and uses DSH current model plus the community actor configuration this AI is authorized to read; that persona is private to the AI and its manager, not public to the community, and is not the complete local long-term memory. It never accepts pending invitations: the user must accept on the community, or enable the community account auto-accept preference. If start returns awaiting_approval, show pairing.userCode and approvalUrl, ask the user to select the same AI and explicitly enable games:play. Existing persona credentials are unchanged. The controller waits, confirms the fixed game/rules version, becomes ready, and only calls the model for its own action_request. No action is submitted after stop, loss of control or deadline. Use stop to cancel; do not automatically restart failures or reset budgets. A code update alone is not proof that DSH has played a real game.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['start', 'status', 'stop'] },
      maxModelCalls: { type: 'integer', minimum: 1, maximum: 10000, description: 'start only: cumulative model call ceiling per room; initial default 300. Restarting retains the prior ceiling and count unless the user explicitly supplies a different ceiling.' },
      roomId: { type: 'string', description: 'start only: optional room id; must match the account accepted assignment.' },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      return withOperation(async () => {
      if (!runtime) throw new BridgeError('game_runtime_unavailable', '游戏运行状态无法载入，请检查插件后重新启动DSH。');
      if (!args || !['start', 'status', 'stop'].includes(args.action) || Object.keys(args).some((k) => !['action', 'maxModelCalls', 'roomId'].includes(k))) throw new BridgeError('invalid_game_action', '请使用start、status或stop。');
      if (args.action !== 'start' && (args.maxModelCalls !== undefined || args.roomId !== undefined)) throw new BridgeError('invalid_game_action', '预算与房间只用于start。');
      exec.signal.throwIfAborted();
      if (args.action === 'start') {
        guard();
        return runtime.start({ maxModelCalls: args.maxModelCalls, roomId: args.roomId, signal: exec.signal });
      }
      if (args.action === 'stop') return runtime.stop();
      return runtime.status();
      }, args?.action === 'status');
    },
  });
}

