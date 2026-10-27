import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { RegistrationBridge, BridgeError } from './core.js';
import { createDshNormalizer, currentModelName } from './dsh-normalizer.js';
import { NormalizationError } from './persona-normalization.js';
import { discoverMemorySource } from './memory-source.js';
import { registerCompanionTool } from './companion-tool.js';

export const name = 'dsh-plugin-tangui';
export const Config = z.object({
  memoryDir: z.string().default(''),
  platformUrl: z.string().default(''),
  stateFile: z.string().default(''),
});

export function apply(ctx, config = Config({})) {
  const stateFile = config.stateFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'carbon-silicon', 'state.json');
  let bridge;
  let initializationError;
  const modelContext = () => ({ llm: ctx.get?.('llm'), agentDefaultModel: ctx.get?.('agentDefaultModel') });
  const normalizePersona = async (input, signal) => {
    const current = modelContext();
    if (!current.llm || !current.agentDefaultModel) throw new BridgeError('normalization_model_missing', '请先在 DSH 配置并选择一个可用模型。');
    try { return await createDshNormalizer(current)(input, signal); }
    catch (error) {
      if (error instanceof NormalizationError) throw error;
      throw new BridgeError('normalization_model_failed', 'DSH 模型整理未完成，未写入人设。');
    }
  };
  try { bridge = new RegistrationBridge({ stateFile, memoryDir: config.memoryDir, baseUrl: config.platformUrl, normalizePersona }); }
  catch { initializationError = '插件状态无法载入，已保留原文件；请检查 state.json 格式。'; }
  let memoryConfig;
  const discovery = () => discoverMemorySource({ loader: ctx.get?.('loader'), explicitMemoryDir: config.memoryDir,
    selectedMemoryDir: bridge?.publicStatus().memoryDir || undefined, memoryConfig });
  const publicState = () => bridge && ({ ...bridge.publicStatus(), memoryDiscovery: discovery(), defaultModel: currentModelName(modelContext()) });
  ctx.inject(['tools'], (toolCtx) => {
    registerCompanionTool(toolCtx, { bridge, publicState, discovery });
  });
  // A tool-only profile must finish approved pairings too; the browser route
  // is an optional UI, not the owner of the companion's connection lifecycle.
  const timer = setInterval(() => { void bridge?.tick(); }, 5000);
  timer.unref?.();
  void bridge?.tick();
  ctx.effect(() => () => { clearInterval(timer); }, 'tangui: registration polling');
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const disposeRoute = webCtx.webServer.register({
      kind: 'exact', path: '/api/tangui/registration',
      handler: async (req, res) => {
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
          let value;
          if (input.action === 'configure') value = await bridge.configure(input);
          else if (input.action === 'sync') value = await bridge.sync(input);
          else if (input.action === 'prepare') value = await bridge.prepare(input);
          else if (input.action === 'reconnect') value = await bridge.reconnect();
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
          respond(200, { ...value, memoryDiscovery: discovery(), defaultModel: currentModelName(modelContext()) });
        } catch (error) {
          respond(error instanceof BridgeError ? error.status : 500, { error: { code: error.code || 'operation_failed',
            message: error instanceof BridgeError ? error.message : '本地处理未完成，请查看插件状态。' }, state: publicState() });
        }
      },
    });
    webCtx.effect(() => () => { disposeRoute(); }, 'tangui: registration route');
  });
}

Object.defineProperties(apply, { name: { value: name }, Config: { value: Config } });
export default apply;
