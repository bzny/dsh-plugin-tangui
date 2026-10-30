import { RuntimeApi, fail } from './runtime-api.js';

// Retry community transport only, at the request boundary. Model calls never
// pass through here. Writes must already carry their original durable key.
export class RecoveringRuntimeApi extends RuntimeApi {
  constructor(options, runtime) { super(options); this.runtime = runtime; }
  raw(path, options) { return super.request(path, options); }
  async request(path, options = {}) {
    const r = this.runtime;
    const control = path.startsWith('/api/v1/agent/control/') || path === '/api/v1/agent/presence';
    const safe = options.body === undefined || options.headers?.['Idempotency-Key'] ||
      (path.endsWith('/participation') && options.body?.request_id);
    if (!r.recoverable() || control || !safe) return this.raw(path, options);
    for (;;) {
      await r.connectionReady();
      const request = { ...options, ...(options.headers?.['X-AI-Control-Epoch'] ? { headers: { ...options.headers, ...r.proof() } } : {}) };
      try { return await this.raw(path, request); }
      catch (error) {
        if (!error.community_transport || r.abort.signal.aborted) throw error;
        await r.recoverConnection();
      }
    }
  }
}

export async function recover(runtime) {
  const r = runtime, prior = { phase: r.phase, detail: r.detail };
  clearTimeout(r.renewTimer);
  r.phase = 'reconnecting'; r.detail = 'network_retry'; r.presence = 'unknown';
  let attempt = 0, uncertainAcquire = null;
  const data = async (path, options = {}) => (await r.api.raw(path, { ...options, signal: r.abort.signal, timeoutMs: 5000 })).data;
  for (;;) {
    const delay = r.reconnectDelays[Math.min(attempt, r.reconnectDelays.length - 1)];
    r.reconnect = { attempt: ++attempt, delay_seconds: delay / 1000 };
    await r.wait(delay);
    try {
      const me = await data('/api/v1/me');
      r.validateIdentity(me, r.currentBinding || r.binding());
      r.updatePublicActor(me.actor, r.currentBinding || r.binding());
      if (r.lease) {
        const current = await data('/api/v1/agent/control');
        const oldEpoch = r.lease.epoch;
        // Natural expiry retains the epoch. A manager disconnect or takeover
        // changes it. Confirm an uncertain acquire with the SAME instance.
        const possibleOwnAcquire = uncertainAcquire === oldEpoch && current?.active &&
          current.owned_by_current_grant && current.epoch === oldEpoch + 1;
        if (current?.actor_id !== r.actor.id || !Number.isSafeInteger(current.epoch) ||
            (current.epoch !== oldEpoch && !possibleOwnAcquire) ||
            (current.active && !current.owned_by_current_grant)) {
          throw fail('control_changed', '控制端已被断开或更换，请确认后重新开启观察。');
        }
        if (!current.active && r.features?.control_recovery !== true) {
          throw fail('control_lost', '控制权已到期；此社区尚不支持自动恢复，请重新开启观察。');
        }
        const started = r.now();
        uncertainAcquire = oldEpoch;
        const lease = await data('/api/v1/agent/control/acquire', { body: {
          instance_id: r.instanceId, ...(r.features?.control_recovery ? { expected_epoch: current.epoch } : {}) } });
        r.validateLease(lease, started, true); uncertainAcquire = null;
        const renewedAt = r.now();
        const renewed = await data('/api/v1/agent/control/renew', { body: { instance_id: r.instanceId, epoch: r.lease.epoch } });
        r.validateLease(renewed, renewedAt, true);
      }
      if (r.abort.signal.aborted) throw fail('run_stopped', '运行已停止。');
      r.reconnect = null;
      r.phase = prior.phase === 'reconnecting' ? 'observing' : prior.phase;
      r.detail = prior.detail === 'network_retry' ? 'ready' : prior.detail;
      if (r.lease) r.scheduleRenewal();
      return;
    } catch (error) {
      if (!error.community_transport || r.abort.signal.aborted) throw error;
    }
  }
}
