import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { RegistrationBridge, BridgeError } from './core.js';
import { createDshNormalizer, currentModelName } from './dsh-normalizer.js';
import { NormalizationError } from './persona-normalization.js';
import { discoverMemorySource } from './memory-source.js';
import { registerCompanionTool } from './companion-tool.js';
import { GameRuntime } from './game-runtime.js';
import { createDshGameDecider } from './game-model.js';
import { registerGameTool } from './game-tool.js';
import { RuntimeConnection } from './runtime-connection.js';
import { CommunityRuntime } from './runtime.js';
import { createRuntimeModel } from './runtime-model.js';
import { PLUGIN_MODEL_MAX_TOKENS } from './model-budget.js';
import { registerRuntimeTool } from './runtime-tool.js';
import { setupUpdates } from './update-integration.js';
import { createModelCallLogger } from './model-call-log.js';
import { ManagementSession, validateManagementSession } from './management-session.js';
import { DIARY_PROMPT, parseDiary } from './local-diary.js';
import { DRAFT_PROMPT, parseDraftDecision, createInterestSearch } from './proactive-drafts.js';

export const name = 'dsh-plugin-tangui';
export const Config = z.object({
  memoryDir: z.string().default(''),
  platformUrl: z.string().default(''),
  stateFile: z.string().default(''),
});

export function apply(ctx, config = Config({})) {
  const stateFile = config.stateFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'carbon-silicon', 'state.json');
  const managementSession = new ManagementSession({ file: join(dirname(stateFile), 'management-session.json'),
    validate: sessionId => validateManagementSession(ctx, sessionId) });
  const callLogger = createModelCallLogger({ directory: join(dirname(stateFile), 'model-logs') });
  let bridge;
  let initializationError;
  const modelContext = () => ({ llm: ctx.get?.('llm'), agentDefaultModel: ctx.get?.('agentDefaultModel') });
  const normalizePersona = async (input, signal) => {
    const current = modelContext();
    if (!current.llm || !current.agentDefaultModel) throw new BridgeError('normalization_model_missing', '请先在 DSH 配置并选择一个可用模型。');
    try { return await createDshNormalizer(current, { callLogger })(input, signal); }
    catch (error) {
      if (error instanceof NormalizationError) throw error;
      throw new BridgeError('normalization_model_failed', 'DSH 模型整理未完成，未写入人设。');
    }
  };
  try { bridge = new RegistrationBridge({ stateFile, memoryDir: config.memoryDir, baseUrl: config.platformUrl, normalizePersona }); }
  catch { initializationError = '插件状态无法载入，已保留原文件；请检查 state.json 格式。'; }
  let gameRuntime;
  if (bridge) {
    try {
      gameRuntime = new GameRuntime({ bridge, stateFile: `${stateFile}.games.json`, decide: createDshGameDecider(modelContext, { callLogger }) });
      bridge.gameRuntime = gameRuntime;
    } catch { /* Preserve invalid game state; persona tools remain usable. */ }
  }
  let runtimeConnection, runtime, runtimeInitializationError;
  if (bridge) {
    try {
      runtimeConnection = new RuntimeConnection({ stateFile: `${stateFile}.runtime-connection.json`, bridge });
      runtime = new CommunityRuntime({ directory: join(dirname(stateFile), 'community-runtime'), connection: runtimeConnection,
        decide: createRuntimeModel(modelContext, { callLogger }), gameRuntime,
        draftModel: createRuntimeModel(modelContext, { callLogger, purpose: 'post_draft', systemPrompt: DRAFT_PROMPT, parse: parseDraftDecision }),
        searchWeb: createInterestSearch(() => ctx.get?.('web')),
        isHostIdle: () => {
          const roots = ctx.get?.('agents')?.roots?.();
          return Array.isArray(roots) && roots.every(agent => agent.status === 'idle' && !(agent.inbox?.nextStep?.length));
        },
        summarize: createRuntimeModel(modelContext, { callLogger, purpose: 'diary_summary', systemPrompt: DIARY_PROMPT, parse: parseDiary }) });
    } catch { runtimeInitializationError = '社区运行状态无法载入；原文件保留，人设连接仍可使用。'; }
  }
  const updates = setupUpdates(ctx, { stateFile, isBusy: () => {
    const persona = bridge?.publicStatus(), community = runtime?.publicStatus(), connection = runtimeConnection?.publicStatus();
    return !!(runtime?.running() || runtimeConnection?.busy || gameRuntime?.busy || gameRuntime?.stepping || persona?.busy ||
      persona?.pendingImport || (persona?.pairing && persona.pairing.expiresAt > Date.now()) || community?.pending || community?.draft_request || community?.engagement?.pending ||
      (connection?.pairing && (!connection.pairing.expired || connection.pairing.uncertain)));
  } });
  const withOperation = (work, readOnly) => updates.gate.run(work, readOnly);
  const guardRuntime = () => {
    if (runtime?.running() || runtimeConnection?.busy || gameRuntime?.busy || bridge?.publicStatus().busy) throw new BridgeError('runtime_busy', '请先结束正在运行的社区或游戏任务，再修改连接或启动新任务。', 409);
  };
  const guardPersona = () => {
    if (runtime?.running() || runtimeConnection?.busy) throw new BridgeError('runtime_busy', '请先停止社区运行，再同步人设或更换连接。', 409);
  };
  let memoryConfig;
  const discovery = () => discoverMemorySource({ loader: ctx.get?.('loader'), explicitMemoryDir: config.memoryDir,
    selectedMemoryDir: bridge?.publicStatus().memoryDir || undefined, memoryConfig });
  const publicState = () => bridge && ({ ...bridge.publicStatus(), memoryDiscovery: discovery(), defaultModel: currentModelName(modelContext()), modelOutputLimit: PLUGIN_MODEL_MAX_TOKENS,
    managementSession: managementSession.publicStatus(),
    modelLogs: callLogger.recent(), lastGameModelCall: gameRuntime?.status().last_model_call || null,
    runtimeConnection: runtimeConnection?.publicStatus(), runtime: runtime?.publicStatus(), runtimeInitializationError, updates: updates.status() });
  ctx.inject(['tools'], (toolCtx) => {
    registerCompanionTool(toolCtx, { bridge, publicState, discovery, guard: guardPersona, withOperation, managementSession });
    const sharedGame = gameRuntime && runtime && {
      status: () => ({ ...gameRuntime.status(), companion: runtime.publicStatus() }),
      start: async options => runtime.startGame(options),
      stop: async () => runtime.stopGame(),
    };
    registerGameTool(toolCtx, sharedGame, { withOperation, managementSession });
    registerRuntimeTool(toolCtx, { runtime, connection: runtimeConnection, guard: guardRuntime, withOperation, managementSession });
  });
  ctx.effect(() => () => { if (gameRuntime?.busy) void gameRuntime.stop('host_stopped'); }, 'tangui: game controller shutdown');
  ctx.effect(() => () => { runtime?.stop(); return runtime?.settled(); }, 'tangui: community runtime shutdown');
  // A tool-only profile must finish approved pairings too; the browser route
  // is an optional UI, not the owner of the companion's connection lifecycle.
  const tick = async () => {
    if (updates.gate.locked) return;
    await withOperation(async () => {
      await Promise.allSettled([runtime?.refreshInbox(), runtime?.refreshPublication()]);
      if (runtime?.running()) return;
      await bridge?.tick();
      if (!runtime?.running()) { await runtimeConnection?.tick(); runtime?.loadDisplayState(); await runtime?.refreshIdleDraftNotices(); }
    });
  };
  const timer = setInterval(() => { void tick(); }, 5000);
  timer.unref?.();
  void tick();
  ctx.effect(() => () => { clearInterval(timer); }, 'tangui: registration polling');
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const disposeRoute = webCtx.webServer.register({
      kind: 'exact', path: '/api/tangui/registration',
      handler: async (req, res) => {
        let releaseOperation;
        const respond = (code, value) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(JSON.stringify(value));
        };
        // Raw webServer routes do not inherit the DSH login gate. Reuse the
        // existing signed-cookie/live-peer check before reading any persona
        // or entering an error branch that includes the settings state.
        let rejection;
        try { rejection = webCtx.connection.requestRejection(req); }
        catch { rejection = 401; }
        if (rejection !== undefined) {
          respond(rejection, { error: { code: 'dsh_auth_required', message: '请先登录此 DSH，再打开插件设置。' } });
          return;
        }
        try {
          const origin = new URL(webCtx.webServer.getOrigin());
          const host = req.headers.host;
          if (!host || host !== origin.host) throw new BridgeError('invalid_host', '仅允许本机 DSH 页面访问。', 403);
          if (req.headers.origin && req.headers.origin !== origin.origin) throw new BridgeError('invalid_origin', '请在本机 DSH 设置页操作。', 403);
          if (!bridge) return respond(503, { error: { code: 'state_invalid', message: initializationError } });
          if (req.method === 'GET') return respond(200, publicState());
          if (req.method !== 'POST') return respond(405, { error: { code: 'method_not_allowed', message: '仅支持 GET/POST。' } });
          if (req.headers['x-tangui-client'] !== '1' || !req.headers['content-type']?.startsWith('application/json') ||
              (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
            throw new BridgeError('invalid_request', '请使用 DSH 插件设置页提交。', 403);
          }
          let length = 0;
          const chunks = [];
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 128 * 1024) throw new BridgeError('body_too_large', '提交内容过大。', 413);
            chunks.push(chunk);
          }
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw new BridgeError('invalid_json', '提交内容不是有效 JSON。'); }
          if (input?.action === 'update_check') { updates.check(); return respond(200, publicState()); }
          if (input?.action === 'update_install') {
            if (typeof input.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version) ||
                typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) {
              throw new BridgeError('invalid_update_target', '请先检查更新，再选择已显示的正式版本。');
            }
            try { updates.install({ version: input.version, commit: input.commit }); }
            catch (error) {
              const messages = { update_busy: '正在检查或安装更新，请稍后再操作。',
                update_restart_required: '插件正在等待重启，请通过原启动器重启 DSH。',
                update_candidate_changed: '可更新版本已变化或尚未检查，请重新检查更新。',
                update_retry_requires_check: '上次更新未完成，请先重新检查并重试。',
                update_settings_invalid: '更新设置无法保存，请先处理面板中的本机状态文件提示。' };
              if (!messages[error.code]) throw error;
              throw new BridgeError(error.code, messages[error.code], 409);
            }
            return respond(200, publicState());
          }
          if (input?.action === 'update_auto') {
            if (typeof input.enabled !== 'boolean') throw new BridgeError('invalid_update_setting', '请明确选择是否自动更新。');
            updates.setAuto(input.enabled); return respond(200, publicState());
          }
          if (input?.action === 'update_hold') {
            if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.clientId) || typeof input.editing !== 'boolean') {
              throw new BridgeError('invalid_update_hold', '无效的编辑状态。');
            }
            updates.hold(input.clientId, input.editing); return respond(200, publicState());
          }
          releaseOperation = updates.gate.enter();
          let value;
          if (['configure', 'sync', 'reconnect'].includes(input.action)) guardPersona();
          if (['runtime_authorize', 'runtime_single', 'runtime_watch', 'publish_post'].includes(input.action)) guardRuntime();
          if (input.action === 'management_bind') {
            if (Object.keys(input).some(key => !['action', 'sessionId'].includes(key))) throw new BridgeError('management_session_invalid', '管理会话设置只接受会话标识。');
            await managementSession.bind(input.sessionId);
          }
          else if (input.action === 'configure') value = await bridge.configure(input);
          else if (input.action === 'sync') value = await bridge.sync(input);
          else if (input.action === 'prepare') value = await bridge.prepare(input);
          else if (input.action === 'reconnect') value = await bridge.reconnect(input);
          else if (input.action === 'diary_read') value = { diaryContent: runtime?.diary?.read(input.name) };
          else if (input.action === 'inbox_refresh') {
            await Promise.allSettled([runtime?.refreshInbox(true), runtime?.refreshPublication()]);
          }
          else if (['runtime_authorize', 'runtime_single', 'runtime_watch', 'runtime_stop', 'publish_post', 'export_activity'].includes(input.action)) {
            if (!runtime || !runtimeConnection) throw new BridgeError('runtime_unavailable', runtimeInitializationError || '社区运行暂不可用。', 409);
            if (input.action === 'runtime_authorize') value = await runtimeConnection.authorize(input);
            else if (input.action === 'runtime_stop') value = runtime.stop();
            else if (input.action === 'export_activity') value = { activityExport: await runtime.exportActivity(input) };
            else value = runtime.start({ ...input, mode: input.action === 'publish_post' ? input.action : input.action.slice(8) });
          }
          else if (input.action === 'discover') {
            memoryConfig = input.memoryConfig;
            const result = discovery();
            const status = bridge.publicStatus();
            if (result.status === 'ready' && !status.binding && !status.enabled && !status.memoryDir && !config.memoryDir) {
              await bridge.configure({ enabled: false, memoryDir: result.memoryDir });
            }
            value = publicState();
          }
          else throw new BridgeError('unknown_action', '未知操作。');
          respond(200, { ...value, ...publicState() });
        } catch (error) {
          respond(error instanceof BridgeError || error.code === 'plugin_updating' ? error.status : 500, { error: { code: error.code || 'operation_failed',
            message: error instanceof BridgeError || error.code === 'plugin_updating' ? error.message : '本地处理未完成，请查看插件状态。' }, state: publicState() });
        } finally { releaseOperation?.(); }
      },
    });
    webCtx.effect(() => () => { disposeRoute(); }, 'tangui: registration route');
  });
  updates.ready();
}

Object.defineProperties(apply, { name: { value: name }, Config: { value: Config } });
export default apply;
