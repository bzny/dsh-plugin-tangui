// Explicit manual smoke, not part of automatic tests. Real host adapter + real
// community HTTP reads; proposed replies are saved locally, never submitted.
// The credential arrives through stdin and is never written to disk or argv.
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider, envApiKeyAuth, InMemoryCredentialStore, defaultProviderAuthContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { CommunityRuntime } from '../lib/runtime.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { createModelCallLogger } from '../lib/model-call-log.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const provider = 'video-overview-smoke';
const model = { id: input.model, name: input.model, provider, api: 'openai-completions', baseUrl: input.model_base_url,
  reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 64000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
// The model is named explicitly, not replaced by a catalog default. Test only:
// no host credential store or running DSH configuration is read or modified.
const profile = { provider, displayName: provider, modelErrors: new Map(), configuredMaxTokens: new Map(),
  streamIdleTimeoutMs: 120000, timeoutMs: 180000,
  maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 4 * 1024 * 1024, requestImageMaxBytes: 1024 * 1024,
  retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 },
  piProvider: createProvider({ id: provider, baseUrl: input.model_base_url, models: [model],
    auth: { apiKey: envApiKeyAuth(provider, []) }, api: openAICompletionsApi() }) };
const profiles = new Map([[provider, profile]]);
const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => input.model_key,
  auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() } });
const save = (path, value) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
};
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let completed = 0;
for (const video of input.videos) {
  const directory = join(input.output, video.id);
  mkdirSync(directory, { recursive: true });
  const resultPath = join(directory, 'reader-result.json');
  if (existsSync(resultPath)) {
    const prior = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (prior.state === 'completed') { completed++; emit({ video: video.id, state: 'reused_completed' }); continue; }
    // Failed calls need a new explicit run directory, not an implicit paid retry.
    emit({ video: video.id, state: 'previous_failure_preserved' }); continue;
  }
  let requests = 0, proposed = null;
  const started = performance.now();
  const callLogger = createModelCallLogger({ directory: join(directory, 'model-logs'),
    append(path, line, options) {
      appendFileSync(path, line, options);
      const item = JSON.parse(line);
      emit({ video: video.id, event: item.event, phase: item.phase, elapsed_ms: item.elapsed_ms });
    } });
  const decide = createRuntimeModel(() => ({
    agentDefaultModel: { currentSelection: () => ({ provider, model: input.model, reasoningEffort: 'medium' }) },
    llm: { async prepareCall(config, signal) {
      requests++;
      const prepared = await adapter.prepareCall(config.provider, config.model, signal);
      return { config, stream: options => prepared.stream(options) };
    } },
  }), { callLogger });
  const runtime = Object.create(CommunityRuntime.prototype);
  Object.assign(runtime, {
    state: { completed: [], model_calls: 0, cursor: '0', identity: { base_url: input.community_url }, deferred_pending: [] },
    actor: { id: 'smoke-partner', name: '岛风酱', kind: 'ai', relationship: 'companion', linked_human_id: 'smoke-human' },
    abort: new AbortController(), checkActive() {}, budget() {}, phaseTo() {}, connectionReady: async () => {},
    commit(value) { Object.assign(this.state, value); }, diary: { record() {} },
    configuration: async () => ({ description: 'AI 秘书舰，活泼、简洁，喜欢游戏和二次元；适度幽默，不勉强回复。',
      effective: { role: '秘书舰', manager_address: '提督' } }),
    async decide(context, ...args) {
      save(join(directory, 'reader-input.json'), context);
      return decide(context, ...args);
    },
    async get(route) {
      const url = new URL(route, input.community_url);
      if (url.origin !== new URL(input.community_url).origin || !url.pathname.startsWith('/api/v1/')) throw new Error('test_route_invalid');
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('test_http_read_failed');
      return response.json();
    },
    async flushPending() {
      // Terminate exactly at the proposal boundary; no public comment POST.
      proposed = this.state.pending?.payload || null;
      this.commit({ pending: null, completed: this.completedFor(`browse:${video.post_id}`, video.post_id, null, true) });
      return true;
    },
  });
  let result;
  try {
    await runtime.decideOn(video.post_id, `browse:${video.post_id}`);
    if (requests !== 1 || runtime.state.model_calls !== 1) throw new Error('test_call_count');
    result = { state: 'completed', participate: runtime.state.last_decision?.participate, body: proposed?.body || '',
      decision_note: runtime.state.last_decision?.decision_note || '', diagnostic: runtime.state.last_model_diagnostic };
    completed++;
  } catch (error) {
    result = { state: 'failed', error_code: typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'integration_failed',
      diagnostic: error.diagnostic || runtime.state.last_model_diagnostic };
  }
  result = { ...result, elapsed_seconds: Math.round((performance.now() - started) / 10) / 100,
    model_requests: requests, max_tokens: 64000, reasoning_effort: 'medium', publication: 'not_submitted' };
  save(resultPath, result);
  emit({ video: video.id, state: result.state, elapsed_seconds: result.elapsed_seconds, completed, total: input.videos.length });
}
input.model_key = '';
process.exitCode = completed === input.videos.length ? 0 : 1;
