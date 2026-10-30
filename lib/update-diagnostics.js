/** Bounded update diagnostics. Never retain upstream messages, stacks or paths. */
const STAGES = new Set(['snapshot', 'install', 'activate', 'verify', 'restore', 'restore_activate', 'restore_verify']);
const OUTCOMES = new Set(['running', 'updated', 'rolled_back', 'error', 'restart_required', 'recovery_required']);
const CODES = new Set([
  'unknown', 'installer_timeout', 'installer_exit', 'installer_incompatible',
  'installed_version_mismatch', 'recovered_version_mismatch', 'invalid_release_target',
  'activation_version_mismatch', 'rollback_version_mismatch',
  'update_source_changed', 'update_install_not_started',
  'hmr_transaction_nested', 'hmr_disposed', 'hmr_outside_transaction',
]);
const SYSTEM_CODES = new Set([
  'EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ETIMEDOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
]);
const HMR_ERRORS = new Map([
  ['HMR transactions cannot be nested', 'hmr_transaction_nested'],
  ['HMR is disposed', 'hmr_disposed'],
  ['HMR profile reconciliation must run inside runExclusive', 'hmr_outside_transaction'],
]);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isVersion = value => typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+$/.test(value);
const isCount = value => Number.isInteger(value) && value >= 0 && value <= 65535;

export function updateFailure(stage, error) {
  const systemCode = SYSTEM_CODES.has(error?.code) ? error.code : error?.cause?.code;
  const code = CODES.has(error?.updateDiagnosticCode) ? error.updateDiagnosticCode :
    CODES.has(error?.code) ? error.code : HMR_ERRORS.get(error?.message) || 'unknown';
  return {
    stage: STAGES.has(stage) ? stage : 'install', code,
    ...(SYSTEM_CODES.has(systemCode) ? { systemCode } : {}),
    ...(Number.isInteger(error?.exitCode) && Math.abs(error.exitCode) <= 65535 ? { exitCode: error.exitCode } : {}),
    ...(isCount(error?.incompatibleCount) ? { incompatibleCount: error.incompatibleCount } : {}),
  };
}

export function updateHostError(code, details = {}) {
  return Object.assign(new Error('plugin update step failed'), { updateDiagnosticCode: code }, details);
}

function restoreFailure(value) {
  if (!value || !STAGES.has(value.stage) || !CODES.has(value.code)) return null;
  return updateFailure(value.stage, { updateDiagnosticCode: value.code, code: value.systemCode,
    exitCode: value.exitCode, incompatibleCount: value.incompatibleCount });
}

/** Old state files have no attempt; unrecognized persisted fields are not exposed. */
export function restoreUpdateAttempt(value) {
  if (!value || !isVersion(value.from) || !isVersion(value.to) || !isTime(value.startedAt) ||
      !STAGES.has(value.stage) || !OUTCOMES.has(value.outcome)) return null;
  return {
    from: value.from, to: value.to, startedAt: value.startedAt,
    finishedAt: isTime(value.finishedAt) ? value.finishedAt : null,
    stage: value.stage, outcome: value.outcome,
    failure: restoreFailure(value.failure), recoveryFailure: restoreFailure(value.recoveryFailure),
    steps: Array.isArray(value.steps) ? value.steps.slice(-7).filter(step =>
      step && STAGES.has(step.stage) && isTime(step.at)).map(({ stage, at }) => ({ stage, at })) : [],
  };
}
