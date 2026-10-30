import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreUpdateAttempt, updateFailure, updateHostError } from '../lib/update-diagnostics.js';

test('updater diagnostic values are allowlisted and never retain raw error properties', () => {
  for (const error of [Error('private endpoint'), { code: 'secret-code', updateDiagnosticCode: 'private-path', exitCode: 'secret' },
    { code: { secret: 'value' }, message: 'private-profile', stack: 'private-stack' }]) {
    assert.deepEqual(updateFailure('activate', error), { stage: 'activate', code: 'unknown' });
  }
  assert.deepEqual(updateFailure('activate', Error('HMR transactions cannot be nested')),
    { stage: 'activate', code: 'hmr_transaction_nested' });
  assert.deepEqual(updateFailure('install', updateHostError('installer_incompatible', { incompatibleCount: 2 })),
    { stage: 'install', code: 'installer_incompatible', incompatibleCount: 2 });
  assert.deepEqual(updateFailure('install', Object.assign(Error('private lock path', { cause: { code: 'EBUSY' } }), { code: 'update_install_not_started' })),
    { stage: 'install', code: 'update_install_not_started', systemCode: 'EBUSY' });
});

test('persisted diagnostics discard unknown fields and cap stage records', () => {
  const value = { from: '0.5.2', to: '0.5.6', startedAt: 10, finishedAt: 20, stage: 'restore_verify', outcome: 'rolled_back',
    failure: { stage: 'install', code: 'installer_exit', exitCode: 1, output: 'private log' },
    recoveryFailure: { stage: 'restore', code: 'private error' }, private: 'secret',
    steps: Array.from({ length: 1000 }, () => ({ stage: 'install', at: 12, secret: 'value' })) };
  const restored = restoreUpdateAttempt(value);
  assert.equal(restored.steps.length, 7);
  assert.equal(restored.recoveryFailure, null);
  assert.doesNotMatch(JSON.stringify(restored), /secret|private|output/);
  assert.deepEqual(restored.failure, { stage: 'install', code: 'installer_exit', exitCode: 1 });
  for (const patch of [{ from: 'private' }, { stage: 'private' }, { outcome: 'secret' }, { startedAt: -1 }]) {
    assert.equal(restoreUpdateAttempt({ ...value, ...patch }), null);
  }
  assert.equal(restoreUpdateAttempt(undefined), null);
});
