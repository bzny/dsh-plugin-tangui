import { appendFileSync, mkdirSync, readdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validationDetails } from './model-retry.js';

const PURPOSES = new Set(['community_reply', 'persona_normalization', 'game_decision', 'game_reflection', 'diary_summary', 'post_draft', 'research_plan', 'research_write']);
const FINISHES = new Set(['stop', 'max-tokens', 'tool-calls', 'error', 'aborted']);
const EVENTS = new Set(['started', 'first_output', 'progress', 'finished', 'retry']);
const PHASES = new Set(['preparing', 'waiting_response', 'receiving', 'completed', 'failed', 'cancelled', 'timed_out', 'waiting_retry']);
const ERRORS = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA',
  'TRANSPORT', 'STREAM_CLOSED', 'TIMEOUT', 'SERVER', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE', 'PI_AI_ERROR', 'ABORTED', 'CONTENT_FILTER', 'REFUSAL', 'UNKNOWN',
  'runtime_model_output_limit', 'runtime_model_incomplete', 'runtime_model_auth', 'runtime_model_rate_limit',
  'runtime_model_transport', 'runtime_model_provider_error', 'runtime_model_refused', 'runtime_model_quota',
  'runtime_model_context_limit', 'runtime_model_timeout', 'runtime_model_missing', 'invalid_model_decision', 'run_stopped',
  'normalization_input_invalid', 'normalization_model_missing', 'normalization_tool_output', 'normalization_incomplete',
  'normalization_output_invalid', 'normalization_json_invalid', 'normalization_empty_output', 'normalization_timeout',
  'normalization_model_failed', 'normalization_schema_invalid', 'normalization_name_missing', 'normalization_value_invalid',
  'normalization_evidence_invalid', 'game_model_missing', 'game_deadline_expired',
  'game_decision_cancelled', 'game_model_failed', 'budget_exhausted', 'control_lost', 'model_route_changed', 'draft_privacy_review']);
const number = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// DSH input counts are disjoint: inputTokens excludes cache reads/writes.
function usageDetails(value = {}) {
  const input = tokens(value.inputTokens), output = tokens(value.outputTokens),
    read = tokens(value.cacheReadTokens), write = tokens(value.cacheWriteTokens),
    total = tokens(value.totalTokens), reasoning = tokens(value.reasoningTokens);
  const summed = [input, read, write].every(n => n !== null) && Number.isSafeInteger(input + read + write) ? input + read + write : null;
  const inferred = total !== null && output !== null && total >= output ? total - output : null;
  const minimum = (input ?? 0) + (read ?? 0) + (write ?? 0);
  const inconsistent = total !== null && (total < minimum || output !== null && (total < output || inferred < minimum || summed !== null && inferred !== summed))
    || reasoning !== null && output !== null && reasoning > output;
  return { input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write,
    total_input_tokens: inconsistent ? null : inferred ?? summed, total_tokens: total, reasoning_tokens: reasoning,
    usage_consistent: inconsistent ? false : inferred !== null && summed !== null ? true : null };
}
const restoredUsage = value => usageDetails({ inputTokens: value.input_tokens, outputTokens: value.output_tokens,
  cacheReadTokens: value.cache_read_tokens, cacheWriteTokens: value.cache_write_tokens,
  totalTokens: value.total_tokens, reasoningTokens: value.reasoning_tokens });
const label = value => typeof value === 'string' && /^[\p{L}\p{N}._/-]{1,200}$/u.test(value) && !value.includes('://') ? value : null;
const errorCode = value => value == null ? null : ERRORS.has(value) ? value : 'UNKNOWN';
export const safeModelCallId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : null;
const NOOP = Object.freeze({ call_id: null, dispatched() {}, observe() {}, finish() {}, retry() {} });
const retryStates = new Set(['scheduled', 'exhausted', 'cancelled', 'stopped']);
function replyDetails(value) {
  const id = value?.reply_target_actor_id ?? value?.actor?.id;
  const linked = value?.reply_target_is_linked_human ?? value?.is_linked_human;
  return { reply_target_actor_id: typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null,
    reply_target_is_linked_human: typeof linked === 'boolean' ? linked : null };
}
function attemptDetails(value) {
  const attempt = Number.isInteger(value?.attempt) && value.attempt >= 1 && value.attempt <= 3 ? value.attempt : null;
  const maximum = value?.maxAttempts ?? value?.max_attempts;
  return { retry_group_id: safeModelCallId(value?.groupId ?? value?.retry_group_id), attempt,
    max_attempts: Number.isInteger(maximum) && maximum >= 1 && maximum <= 3 ? maximum : null };
}

function restoredEntry(value, date) {
  if (!value || Array.isArray(value) || value.client !== 'dsh' || !PURPOSES.has(value.purpose) ||
      !EVENTS.has(value.event) || !PHASES.has(value.phase) || typeof value.call_id !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.call_id) ||
      typeof value.time !== 'string' || value.time.slice(0, 10) !== date ||
      !Number.isFinite(Date.parse(value.time)) || new Date(value.time).toISOString() !== value.time) return null;
  return Object.freeze({ time: value.time, call_id: value.call_id, client: 'dsh', purpose: value.purpose,
    event: value.event, phase: value.phase, model: label(value.model), provider: label(value.provider),
    max_tokens: tokens(value.max_tokens), timeout_ms: tokens(value.timeout_ms),
    timeout_kind: value.timeout_kind === 'total_deadline' ? value.timeout_kind : null,
    deadline_remaining_ms: tokens(value.deadline_remaining_ms), elapsed_ms: tokens(value.elapsed_ms),
    first_output_ms: tokens(value.first_output_ms), text_characters: tokens(value.text_characters),
    reasoning_characters: tokens(value.reasoning_characters), ...restoredUsage(value),
    finish_kind: FINISHES.has(value.finish_kind) || value.finish_kind === 'unknown' ? value.finish_kind : null,
    error_code: errorCode(value.error_code), ...attemptDetails(value), ...validationDetails(value), ...replyDetails(value),
    retry_status: retryStates.has(value.retry_status) ? value.retry_status : null,
    retry_after_ms: tokens(value.retry_after_ms), failure_sample_id: safeModelCallId(value.failure_sample_id) });
}

function restoreRecent(directory) {
  const entries = [];
  try {
    const names = readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-2);
    for (const name of names) {
      let fd;
      try {
        fd = openSync(join(directory, name), 'r');
        const size = fstatSync(fd).size, start = Math.max(0, size - 262144);
        const buffer = Buffer.alloc(Math.min(size, 262144));
        const length = readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, length).toString('utf8').split('\n');
        if (start > 0) lines.shift();
        for (const line of lines) {
          try {
            const entry = restoredEntry(JSON.parse(line), name.slice(0, 10));
            if (entry) { entries.push(entry); if (entries.length > 10) entries.shift(); }
          } catch { /* Ignore truncated lines and untrusted prior log contents. */ }
        }
      } catch { /* A damaged or unavailable historical log is not a model failure. */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* read-only descriptor cleanup */ } } }
    }
  } catch { /* No prior log is a valid first launch. */ }
  return entries;
}

/** Isolate log failures (including a custom sink) from model-call behavior. */
export function beginModelCall(logger, options) {
  if (!logger) return NOOP;
  let call;
  try { call = logger.start(options); } catch { return NOOP; }
  const safe = method => (...args) => { try { call?.[method]?.(...args); } catch { /* logging never changes a model result */ } };
  return { call_id: safeModelCallId(call?.call_id), dispatched: safe('dispatched'), observe: safe('observe'), finish: safe('finish'), retry: safe('retry') };
}

/** Daily local JSONL containing counters and fixed classifications, never text. */
export function createModelCallLogger({ directory, now = () => Date.now(), monotonic = () => performance.now(),
  setTimer = setInterval, clearTimer = clearInterval, append = appendFileSync, makeDirectory = mkdirSync, failureSamples } = {}) {
  const recent = restoreRecent(directory);
  const write = entry => {
    recent.push(entry); if (recent.length > 10) recent.shift();
    try {
      makeDirectory(directory, { recursive: true });
      append(join(directory, `${entry.time.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* Missing or read-only storage must not cancel the model call. */ }
  };
  return {
    recent: () => recent.map(value => ({ ...value })),
    start({ purpose, model, provider, maxTokens, timeoutMs, deadlineRemainingMs, attemptInfo, replyTarget } = {}) {
      const started = monotonic(), id = randomUUID();
      const blocks = new Map();
      let phase = 'preparing', firstOutput = null, usage = usageDetails(),
        finishKind = null, failure = null, finished = false, timer;
      let validation = validationDetails(null), retryStatus = null, retryAfterMs = null;
      let sample, sampleId = null;
      try { sample = failureSamples?.begin(id); } catch { /* Optional capture must not affect calls. */ }
      const emit = event => {
        try {
          const values = [...blocks.values()];
          write(Object.freeze({ time: new Date(now()).toISOString(), call_id: id, client: 'dsh',
            purpose: PURPOSES.has(purpose) ? purpose : null, event, phase, model: label(model), provider: label(provider),
            max_tokens: tokens(maxTokens), timeout_ms: number(timeoutMs), timeout_kind: 'total_deadline',
            deadline_remaining_ms: number(deadlineRemainingMs), elapsed_ms: number(monotonic() - started),
            first_output_ms: firstOutput, text_characters: values.filter(v => v.kind === 'text').reduce((n, v) => n + v.characters, 0),
            reasoning_characters: values.filter(v => v.kind === 'reasoning').reduce((n, v) => n + v.characters, 0),
            ...usage, finish_kind: finishKind, error_code: failure,
            ...attemptDetails(attemptInfo), ...validation, ...replyDetails(replyTarget), retry_status: retryStatus, retry_after_ms: retryAfterMs, failure_sample_id: sampleId }));
        } catch { /* Even clock, serialization, and filesystem errors stay local. */ }
      };
      emit('started');
      try { timer = setTimer(() => { if (!finished) emit('progress'); }, 15000); timer?.unref?.(); } catch { /* no periodic logger */ }
      return {
        call_id: id,
        dispatched() { if (!finished) { phase = 'waiting_response'; emit('progress'); } },
        observe(chunk) {
          if (finished) return;
          try { sample?.observe(chunk); } catch { /* Isolate optional capture. */ }
          let hasOutput = false;
          if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
            const block = blocks.get(chunk.index) || { kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', characters: 0 };
            if (!block.closed && typeof chunk.text === 'string') {
              block.characters += chunk.text.length; hasOutput = chunk.text.trim().length > 0;
            }
            blocks.set(chunk.index, block);
          }
          if (chunk?.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type) && !blocks.get(chunk.index)?.closed) {
            const text = typeof chunk.block.text === 'string' ? chunk.block.text : '';
            blocks.set(chunk.index, { kind: chunk.block.type, characters: text.length, closed: true });
            hasOutput = text.trim().length > 0;
          }
          // Usage events are cumulative snapshots, never increments to sum.
          if (chunk?.type === 'usage') usage = usageDetails(chunk.usage ?? {});
          if (chunk?.type === 'finish') {
            finishKind = FINISHES.has(chunk.reason?.kind) ? chunk.reason.kind : 'unknown';
            if (['error', 'aborted'].includes(finishKind)) failure = errorCode(chunk.reason?.failure?.code ?? 'UNKNOWN');
          }
          if (hasOutput) {
            phase = 'receiving';
            if (firstOutput === null) { firstOutput = number(monotonic() - started); emit('first_output'); }
          }
        },
        finish({ code = null, sourceCode = null, cancelled = false, timedOut = false, validation: details } = {}) {
          if (finished) return;
          finished = true;
          try { clearTimer(timer); } catch { /* timer cleanup cannot change the call */ }
          const upstream = errorCode(sourceCode), outcome = errorCode(code);
          validation = validationDetails(details);
          if (upstream !== null && upstream !== 'UNKNOWN' && /^[A-Z_]+$/.test(upstream)) failure = upstream;
          if (!failure || failure === 'UNKNOWN' || !['normalization_incomplete', 'normalization_model_failed', 'game_model_failed', 'invalid_model_decision', 'runtime_model_provider_error'].includes(outcome)) failure = outcome ?? failure;
          phase = cancelled ? 'cancelled' : timedOut || failure === 'TIMEOUT' ? 'timed_out' : failure ? 'failed' : 'completed';
          try { sampleId = safeModelCallId(sample?.finish({ failed: !!failure, cancelled, complete: finishKind === 'stop' })); } catch { /* Keep the original outcome. */ }
          emit('finished');
        },
        retry({ status, delayMs, error } = {}) {
          if (!finished || !retryStates.has(status)) return;
          retryStatus = status; retryAfterMs = number(delayMs);
          phase = status === 'scheduled' ? 'waiting_retry' : status === 'cancelled' ? 'cancelled' : 'failed';
          if (status === 'stopped') failure = errorCode(error?.code);
          emit('retry');
        },
      };
    },
  };
}
