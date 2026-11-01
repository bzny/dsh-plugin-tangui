import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './core.js';

export const MODEL_MAX_ATTEMPTS = 3;
const reasons = new Set(['empty_output', 'json_syntax', 'object_required', 'missing_field', 'field_type',
  'field_length', 'unknown_field', 'empty_reply', 'invalid_attachment', 'invalid_sticker',
  'unsupported_output', 'schema_invalid', 'invalid_choice', 'invalid_evidence', 'reply_target_mismatch', 'manager_address_misuse']);
const fields = new Set(['participate', 'body', 'reflection', 'decision_note', 'attachments', 'sticker_codes',
  'action_id', 'commentary', 'memory_note', 'name', 'overrides', 'title', 'topics', 'source_ids', 'reply_to_actor_id']);
export function validationDetails(error) {
  return { validation_reason: reasons.has(error?.validation_reason) ? error.validation_reason : null,
    validation_field: fields.has(error?.validation_field) ? error.validation_field : null };
}
export function invalidModelOutput(error, reason, field = null) {
  return Object.assign(error, validationDetails({ validation_reason: reason, validation_field: field }));
}
const permanent = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA',
  'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'CONTENT_FILTER', 'REFUSAL']);
const failureCodes = new Set([...permanent, 'RATE_LIMIT', 'TRANSPORT', 'STREAM_CLOSED',
  'TIMEOUT', 'SERVER', 'EMPTY_RESPONSE', 'PI_AI_ERROR', 'ABORTED']);
export const safeModelFailureCode = code => failureCodes.has(code) ? code : 'UNKNOWN';

// DSH contexts can expose services through prototype/proxy getters. Never spread them.
export function captureModelContext(source) {
  const read = () => typeof source === 'function' ? source() : source;
  const current = read(), selected = current?.agentDefaultModel?.currentSelection();
  const route = selected && { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort };
  const context = { llm: current?.llm, attachments: current?.attachments, agentDefaultModel: { currentSelection: () => route } };
  return { context, ensureCurrent() {
    let next;
    try { next = read()?.agentDefaultModel?.currentSelection(); } catch { /* Report only the fixed category below. */ }
    if (!next || next.provider !== route?.provider || next.model !== route?.model || next.reasoningEffort !== route?.reasoningEffort) {
      throw new BridgeError('model_route_changed', '所选模型已改变，已停止本次重试；请按新设置重新开始。');
    }
  } };
}
const retryable = new Set(['invalid_model_decision', 'runtime_model_incomplete', 'runtime_model_transport',
  'runtime_model_rate_limit', 'runtime_model_timeout', 'runtime_model_provider_error',
  'normalization_tool_output', 'normalization_output_invalid', 'normalization_json_invalid',
  'normalization_empty_output', 'normalization_timeout', 'normalization_model_failed',
  'normalization_schema_invalid', 'normalization_name_missing', 'normalization_value_invalid',
  'normalization_evidence_invalid', 'game_model_failed']);
export function mayRetryModel(error) {
  if (permanent.has(error?.diagnostic?.failureCode) || permanent.has(error?.sourceCode)) return false;
  if (error?.diagnostic?.finishKind === 'max-tokens') return false;
  return retryable.has(error?.code) || (error?.code === 'normalization_incomplete' && error?.diagnostic?.finishKind !== 'max-tokens');
}
export function retryInstruction(error) {
  const { validation_reason: reason, validation_field: field } = validationDetails(error);
  if (reason === 'reply_target_mismatch') return '\n上一次回应对象未通过校验，没有发表。请确认 reply_target.actor.id，公开回复只面向该账号，并原样填入 reply_to_actor_id；不要改成自己的管理者。';
  if (reason === 'manager_address_misuse') return '\n上一次把管理者专属称呼用于其他账号，没有发表。请重新按 reply_target 写给真实作者，用对方公开昵称或不带昵称的自然回应；保持原本性格，不搬用与管理者的私人关系。';
  return reason ? `\n上一次返回未通过程序校验（${reason}${field ? `，字段 ${field}` : ''}），没有执行或发表。请重新按上述输出格式完整作答，不添加额外字段或说明，不调用工具。` : '';
}

/** Only generation is repeated. Callers reserve each extra call before dispatch. */
export async function runModelAttempts(work, { signal, maxAttempts = MODEL_MAX_ATTEMPTS,
  delays = [2000, 5000], beforeRetry, notify } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MODEL_MAX_ATTEMPTS) throw new Error('Invalid model attempt limit');
  const groupId = randomUUID();
  const report = value => { try { notify?.(value); } catch { /* Diagnostics never drive retry decisions. */ } };
  let previousError;
  const stopped = () => new BridgeError('run_stopped', '模型调用已停止，未继续重试。');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await work({ groupId, attempt, maxAttempts, previousError });
    } catch (error) {
      if (signal?.aborted) throw error?.code === 'run_stopped' ? error : stopped();
      if (!mayRetryModel(error)) throw error;
      if (attempt === maxAttempts) {
        report({ status: 'exhausted', error, attempt, maxAttempts, groupId, delayMs: 0 });
        error.attempts = attempt;
        if (attempt > 1) error.message = `已连续尝试 ${attempt} 次仍未获得可用结果。${error.message}`;
        throw error;
      }
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      report({ status: 'scheduled', error, attempt, maxAttempts, groupId, delayMs });
      try {
        if (delayMs > 0) await delay(delayMs, undefined, { signal });
        signal?.throwIfAborted();
        await beforeRetry?.({ attempt: attempt + 1, previousError: error });
        signal?.throwIfAborted();
      } catch (blocked) {
        const safe = signal?.aborted ? stopped() : blocked;
        report({ status: signal?.aborted ? 'cancelled' : 'stopped', error: safe, attempt, maxAttempts, groupId, delayMs: 0 });
        throw safe;
      }
      previousError = error;
    }
  }
}
