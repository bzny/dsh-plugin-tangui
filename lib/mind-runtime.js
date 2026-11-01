import { createHash } from 'node:crypto';

// State failure is visible but must not turn an existing community/game action
// into a retry or discard a valid model response.
export function mindSafely(runtime, work) {
  if (!runtime.mind?.enabled()) return null;
  try { return work(runtime.mind); }
  catch { runtime.mind.error = '本次伙伴状态未更新，原记录保留；其他活动继续。'; return null; }
}

export function mindResting(runtime) {
  return !!mindSafely(runtime, mind => {
    const rest = mind.status().rest;
    return rest?.activity === 'rest' && Date.parse(rest.until) > runtime.wallNow();
  });
}

export function recordCommunityMind(runtime, { id, post, reflection, appraisal }) {
  return mindSafely(runtime, mind => {
    if (!reflection && !appraisal) return null;
    const event = mind.noteEvent({ id, source: 'community', summary: `读到公开帖子《${(post.title || '').slice(0, 160)}》；${(reflection || '').slice(0, 1800)}`,
      reflection: reflection || '', public_material: true });
    if (event && appraisal) return mind.recordAppraisal({ ...appraisal, event_ids: [event.id] });
    return event;
  });
}

export function recordGameMind(runtime, record) {
  if (record.status !== 'completed') return;
  mindSafely(runtime, mind => {
    const event = mind.noteEvent({ id: `game:${record.id}`, source: record.resuming ? 'rest' : 'game', summary: record.resuming ? '获准活动的休息期限已到，重新考虑下一步。' : record.room_id ? '已完成本场游戏回想。' : '正在考虑获准的游戏活动。',
      reflection: record.result.reflection, at: record.at });
    if (!event) return;
    if (record.result.appraisal) mind.recordAppraisal({ ...record.result.appraisal, ...(record.resuming ? { delta: {}, growth: null } : {}), event_ids: [event.id] });
    else {
      const current = mind.viewCurrent();
      const delta = Object.fromEntries(['mood', 'pressure'].map(k => [k, Math.max(-10, Math.min(10, record.result.state[k] - current.values[k]))]));
      // Compatibility with an existing game model response; its authored
      // interpretation is retained, without a second model call.
      mind.recordAppraisal({ event_ids: [event.id], summary: record.result.note, reflection: record.result.reflection, delta: record.resuming ? {} : delta,
        activities: { play: record.result.state.interest }, ...(record.result.rest_minutes ? { rest_minutes: record.result.rest_minutes } : {}) });
    }
  });
}

/** Called only by the already-authorized owner loop, when its host is idle. */
export async function serviceMind(runtime) {
  const mind = runtime.mind;
  if (!mind?.enabled() || !runtime.mindModel || runtime.mode !== 'watch' || !runtime.isHostIdle() || runtime.abort.signal.aborted) return false;
  if (runtime.preferences?.community?.paused || runtime.preferences?.community?.quiet_now || mind.quiet()) return false;
  if (runtime.gameRuntime?.busy || runtime.state.pending || runtime.state.deferred_pending?.length) return false;
  if (runtime.lifeHost?.canDeliver()) await mind.deliverContact((text, id) => runtime.lifeHost.deliver(text, id));
  if (!mind.reviewDue()) return false;
  const state = mind.load();
  if (state.rest && Date.parse(state.rest.until) <= runtime.wallNow()) mind.noteEvent({ id: `wake:${state.rest.until}`, source: 'rest', summary: '先前安排的休息期限已到，可以重新考虑活动；尚未执行新的活动。' });
  const events = mind.pending(); if (!events.length) return false;
  const key = 'review:' + createHash('sha256').update(events.map(e => e.id).join('\n')).digest('hex').slice(0, 32);
  if (state.attempts[key]) return false; // Never repeat an interrupted generation.
  if (runtime.state.model_calls >= runtime.limits.max_model_calls) return false;
  runtime.checkActive(); runtime.budget('diary');
  const identity = JSON.stringify(mind.activeIdentity()), ownerFile = runtime.stateFile;
  const context = { ...mind.context(), persona: await runtime.configuration(), public_materials: [] };
  runtime.checkActive();
  if (JSON.stringify(mind.activeIdentity()) !== identity || !mind.enabled()) return false;
  // Reserve against the existing cumulative budget BEFORE any model dispatch.
  runtime.commit({ model_calls: runtime.state.model_calls + 1 });
  if (!mind.beginAttempt(key, events.map(e => e.id))) return false;
  runtime.phaseTo('thinking', 'reflecting_companion');
  let diagnostic;
  try {
    const result = await runtime.mindModel(context, runtime.abort.signal, d => { diagnostic = d; runtime.commit({ last_model_diagnostic: d }); }, id => runtime.noteModelCall(id, 'generating'));
    runtime.checkActive();
    if (runtime.stateFile !== ownerFile || JSON.stringify(mind.activeIdentity()) !== identity || !mind.enabled()) return false;
    const allowed = new Set(events.map(e => e.id));
    if (result.event_ids.some(id => !allowed.has(id))) throw new Error('event_mismatch');
    mind.recordAppraisal(result);
    mind.finishAttempt(key, 'completed', diagnostic);
    runtime.noteModelCall(runtime.mindModel.last_call_id, 'accepted');
  } catch {
    if (JSON.stringify(mind.activeIdentity()) === identity) mind.finishAttempt(key, 'failed', diagnostic);
    runtime.noteModelCall(runtime.mindModel.last_call_id, 'model_failed');
    mind.error = '这次自主回想未完成，调用已计数，没有改变心情或自动重试。';
  }
  return true;
}
