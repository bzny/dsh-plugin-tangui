import { BridgeError } from './core.js';
import { captureManagementSession } from './management-session.js';

export function registerGameTool(ctx, runtime, { guard = () => {}, withOperation = work => work(), managementSession } = {}) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name !== 'tangui_game' || exec.arguments?.action !== 'start' || decision.kind !== 'allow') return decision;
    return { kind: 'ask', reason: 'Run the connected companion using the current local model budget; accept invitations only according to website consent.',
      displayReason: { en: 'Start the connected companion for games?',
        zh: '启动已连接的伙伴参加小游戏？使用当前本地模型与预算，按网站设置接受邀请。' } };
  });
  ctx.tools.register({
    name: 'tangui_game',
    description: 'Use the same connected companion and controller for carbon-silicon.turn-game.v1 games. No extra game authorization code is needed. Website account settings decide automatic invitation acceptance; otherwise wait for a human to accept there. An already running community companion checks invitations automatically and pauses community and diary work while playing. start uses the current DSH model and its selected reasoning strength, 64000 output ceiling, local per-room budget, and community persona. Only own action_request may produce decisions. Do not submit after stop, lost control or deadline. stop stops local game participation and preserves any prior community observation, including its pauses and cumulative budgets. The stopped room is not automatically rejoined; an explicit start can allow it again. If started solely for games, stop returns to stopped. To stop ALL companion activity use tangui_community stop. No private long-term memory is uploaded.',
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
        const result = await runtime.start({ maxModelCalls: args.maxModelCalls, roomId: args.roomId, signal: exec.signal });
        await captureManagementSession(managementSession, exec);
        return result;
      }
      if (args.action === 'stop') return runtime.stop();
      return runtime.status();
      }, args?.action === 'status');
    },
  });
}
