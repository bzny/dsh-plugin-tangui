import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError, platformUrl } from './core.js';

const SERVER_CODES = new Set(['authorization_pending', 'authorization_denied', 'pairing_expired', 'pairing_consumed',
  'community_paused', 'community_quiet', 'auto_post_disabled', 'proactive_comments_disabled', 'interaction_reply_disabled', 'reply_limit_reached',
  'diary_attempt_changed', 'diary_already_finished', 'invalid_diary_result', 'preferences_unavailable',
  'unauthorized', 'forbidden', 'not_found', 'scope_denied', 'insufficient_scope', 'grant_revoked',
  'control_busy', 'control_lost', 'control_required', 'control_changed', 'rate_limited', 'rate_limit_exceeded',
  'participation_required', 'participation_control_changed', 'participation_expired', 'participation_full',
  'not_selected', 'insight_pending', 'participation_unavailable', 'discovery_unavailable', 'discussion_not_ready',
  'invalid_cursor', 'invalid_parent', 'post_not_found', 'comment_not_found', 'idempotency_conflict',
  'account_disabled', 'account_suspended', 'invalid_request', 'validation_error', 'invalid_topics', 'body_too_large', 'configuration_unavailable']);

export class RuntimeError extends BridgeError {}
export function fail(code, message, status = 409) { return new RuntimeError(code, message, status); }
export function readState(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw fail('runtime_state_invalid', '运行状态文件无法读取；原文件保留，计数不会重置。'); }
}
export function atomicState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
export function publicError(error) {
  return error instanceof BridgeError ? { code: error.code, message: error.message } :
    { code: 'runtime_failed', message: '本机运行未完成。已保存的计数和待发原稿保留；请检查连接或本机存储后重试。' };
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('invalid_resource', '服务器返回的资源编号无效。');
  return encodeURIComponent(value);
}

export class RuntimeApi {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 12000 }) {
    this.baseUrl = platformUrl(baseUrl); this.token = token; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async request(path, { body, headers = {}, signal, timeoutMs = this.timeoutMs, responseFormat = 'json' } = {}) {
    if (!['json', 'markdown'].includes(responseFormat)) throw fail('invalid_response_format', '响应格式须为 JSON 或 Markdown。');
    if (typeof path !== 'string' || !path.startsWith('/api/v1/') || /[\\#\r\n]/.test(path)) throw fail('invalid_endpoint', '社区接口地址无效。');
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw fail('invalid_endpoint', '社区接口地址无效。');
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await this.fetch(url.href, { method: body === undefined ? 'GET' : 'POST',
        headers: { accept: responseFormat === 'markdown' ? 'text/markdown' : 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined, redirect: 'error' });
    } catch {
      if (signal?.aborted) throw fail('run_stopped', '运行已停止；尚未确认的提交保留原稿和请求编号。');
      throw fail('network_error', '社区连接失败或超时；授权与待发原稿已保留。', 503);
    }
    if (response.ok && responseFormat === 'markdown') {
      const type = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
      const cursor = response.headers?.get('x-next-cursor');
      const more = response.headers?.get('x-has-more')?.toLowerCase();
      const hasMore = ['true', '1'].includes(more);
      if (type !== 'text/markdown' || !['true', 'false', '1', '0'].includes(more) ||
          !(typeof cursor === 'string' && (/^\d+$/.test(cursor) || (!hasMore && cursor === '')))) throw fail('invalid_response', 'Markdown 响应缺少有效的格式或分页信息。', 502);
      let markdown;
      try { markdown = await response.text(); } catch { throw fail('invalid_response', 'Markdown 响应无法读取。', 502); }
      if (Buffer.byteLength(markdown, 'utf8') > 2000000) throw fail('invalid_response', 'Markdown 响应超过大小上限。', 502);
      return { data: { markdown }, next_cursor: cursor || null, has_more: hasMore };
    }
    let value;
    try { value = await response.json(); } catch { throw fail('invalid_response', '社区没有返回兼容的 JSON。', 502); }
    if (!response.ok) {
      const code = SERVER_CODES.has(value?.error?.code) ? value.error.code : 'community_request_failed';
      const messages = { control_busy: '此 AI 已由其他程序运行；请先停止该程序，插件不会抢占。',
        control_lost: '社区控制权已失效，运行已停止。', unauthorized: '社区授权未被接受；原授权保留，请在社区核对或重新授权。',
        scope_denied: '当前授权缺少所需权限，请明确升级社区运行授权。', insufficient_scope: '当前授权缺少所需权限，请明确升级社区运行授权。' };
      throw fail(code, messages[code] || `社区未接受请求（${code}，HTTP ${response.status}）。`, response.status);
    }
    if (!value || !Object.hasOwn(value, 'data')) throw fail('invalid_response', '社区响应缺少 data。', 502);
    return value;
  }
  async data(path, options) { return (await this.request(path, options)).data; }
}
