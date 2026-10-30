import { fail, identifier } from './runtime-api.js';
import { safeModelCallId } from './model-call-log.js';
import { newLife, validateLife, lifeView, applyLifeResult } from './companion-life.js';
import { normalizePostDraft, refreshDrafts, flushDraftRequest, publicWebUrl } from './proactive-drafts.js';

const clone = value => JSON.parse(JSON.stringify(value));
const ended = new Set(['finished', 'completed', 'ended', 'aborted', 'interrupted', 'error']);
const activity = new Set(['ready', 'queued', 'preparing', 'playing', 'awaiting_reflection', 'stopped']);
const safeCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,70}$/.test(error.code) ? error.code : 'model_failed';
function life(runtime) { return clone(validateLife(runtime.state.companion_life || newLife(runtime.wallNow()))); }
function commitLife(runtime, value) { runtime.commit({ companion_life: value }); }
function attemptPatch(runtime, key, patch) {
  const value = life(runtime); value.attempts[key] = { ...value.attempts[key], ...patch }; commitLife(runtime, value);
  return value.attempts[key];
}

export function reserveSeriesCall(runtime, sessionId, reservation) {
  const value = life(runtime), series = value.series[sessionId] || { calls: 0, reservations: {} };
  if (series.reservations[reservation]) return;
  if (series.calls >= (runtime.gameRuntime.state.maxModelCalls || 300)) throw fail('budget_exhausted', '本次自主游戏活动已到累计调用上限；重启不会清零。');
  series.reservations[reservation] = true; series.calls++; value.series[sessionId] = series; commitLife(runtime, value);
}
export function reserveGameCall(runtime, roomId, requestId) {
  const sessionId = runtime.state.companion_life?.room_sessions?.[roomId];
  if (sessionId) reserveSeriesCall(runtime, sessionId, `action:${roomId}:${requestId}`);
}
export function publicLifeStatus(runtime) {
  const value = runtime.state?.companion_life;
  if (!value) return null;
  const attempts = Object.values(value.attempts), last = attempts.at(-1);
  return { ...lifeView(value, runtime.wallNow()), autoplay: value.autoplay || null, local_paused: !!value.local_pause,
    local_stop_error: value.local_pause?.cancel_error || null,
    series_calls: value.autoplay ? value.series[value.autoplay.id]?.calls || 0 : 0,
    max_model_calls: runtime.gameRuntime?.state.maxModelCalls || 300,
    last_reflection: last ? { id: last.id, room_id: last.room_id, status: last.status, error: last.error || null,
      reflection: last.result?.reflection || '', next_activity: last.status === 'completed' ? last.result.next_activity : null,
      decision_reported: !!last.decision_reported, draft_status: last.draft_status || null, call_id: safeModelCallId(last.call_id) } : null };
}

export async function pauseAutoplay(runtime) {
  const value = runtime.state?.companion_life, session = value?.autoplay;
  if (!session || !['ready', 'queued', 'preparing', 'playing', 'awaiting_reflection'].includes(session.status)) return false;
  const next = clone(value); next.local_pause = { session_id: session.id, at: new Date(runtime.wallNow()).toISOString() };
  commitLife(runtime, next);
  runtime.gameRuntime.participationPaused = true;
  runtime.lifeAbort?.abort();
  await runtime.gameRuntime.stopCurrent();
  if (!runtime.running() || runtime.abort.signal.aborted) return true;
  try {
    const response = await runtime.api.data('/api/v1/game-matchmaking', { signal: runtime.abort.signal, headers: runtime.proof() });
    if (!Array.isArray(response?.tickets)) throw fail('invalid_matchmaking_tickets', '匹配票列表无效。');
    for (const ticket of response.tickets) {
      if (ticket.autoplay_session_id === session.id && ticket.members?.some(m => m.actor_id === runtime.actor.id) && ['queued', 'preparing'].includes(ticket.status)) {
        await runtime.write(`/api/v1/game-matchmaking/tickets/${identifier(ticket.id)}/cancel`, {}, `local-stop-${session.id}-${ticket.id}`);
      }
    }
  } catch (error) {
    const saved = life(runtime); saved.local_pause.cancel_error = safeCode(error); commitLife(runtime, saved);
  }
  return true;
}

function validSession(value, actorId) {
  if (value === null) return null;
  if (!value || value.actor_id !== actorId || typeof value.enabled !== 'boolean' || !activity.has(value.status) ||
      !Array.isArray(value.choices) || !value.choices.length || !Number.isSafeInteger(value.started_games) || value.started_games < 0 ||
      !Number.isSafeInteger(value.completed_games) || value.completed_games < 0 ||
      !(value.max_games === null || Number.isSafeInteger(value.max_games) && value.max_games > 0)) throw fail('invalid_autoplay_session', '自主游戏活动响应不完整。');
  identifier(value.id);
  for (const choice of value.choices) { identifier(choice.game_id); if (!choice.settings || !Number.isSafeInteger(choice.settings.player_count)) throw fail('invalid_autoplay_session', '自主活动未明确游戏人数。'); }
  return clone(value);
}

async function refreshMatching(runtime, force = false) {
  if (!force && runtime.matchingCheckedAt !== undefined && runtime.wallNow() - runtime.matchingCheckedAt < 5000) return;
  runtime.matchingCheckedAt = runtime.wallNow();
  const response = await runtime.api.data('/api/v1/agent/game-autoplay', { signal: runtime.abort.signal, headers: runtime.proof() });
  const session = validSession(response?.session, runtime.actor.id);
  let value = life(runtime); value.autoplay = session; commitLife(runtime, value);
  const list = await runtime.api.data('/api/v1/game-matchmaking', { signal: runtime.abort.signal, headers: runtime.proof() });
  if (!Array.isArray(list?.tickets)) throw fail('invalid_matchmaking_tickets', '匹配票列表无效。');
  for (const ticket of list.tickets) {
    if (!ticket.members?.some(m => m.actor_id === runtime.actor.id) || !['queued', 'preparing', 'playing'].includes(ticket.status)) continue;
    identifier(ticket.id);
    // This credential extends only this AI's heartbeat; it cannot keep a human online.
    if (['queued', 'preparing'].includes(ticket.status)) await runtime.write(`/api/v1/game-matchmaking/tickets/${ticket.id}/heartbeat`, {}, `match-heartbeat-${ticket.id}-${Math.floor(runtime.wallNow() / 5000)}`);
    if (ticket.room?.id && ticket.autoplay_session_id) {
      value = life(runtime); value.room_sessions[ticket.room.id] = ticket.autoplay_session_id; commitLife(runtime, value);
    }
  }
  if (session?.last_room_id && ['playing', 'awaiting_reflection'].includes(session.status)) {
    value = life(runtime); value.room_sessions[session.last_room_id] = session.id; commitLife(runtime, value);
  }
}

function contextFor(runtime, session, experience, roomId) {
  const value = life(runtime), journal = roomId ? runtime.gameRuntime.state.journals[roomId] : null;
  const publicRecord = experience ? { view: experience.public_view, result: experience.public_result } : null;
  const evidence = experience ? [{ evidence_id: `room:${roomId}:public`, public_record: publicRecord }] : [];
  const canShare = experience?.can_share === true;
  const participants = Array.isArray(experience?.participants) ? experience.participants.map(p => ({ actor_id: p.actor_id ?? p.id, name: p.name, kind: p.kind })) : [];
  const sourceId = `game:${roomId}`;
  return { phase: roomId ? 'reflection' : 'plan', self: { id: runtime.actor.id, name: runtime.actor.name, kind: 'ai' },
    room_id: roomId, room: experience?.room || null, participants, evidence,
    choices: session?.enabled === true ? clone(session.choices) : [],
    session: session ? { id: session.id, started_games: session.started_games, completed_games: session.completed_games,
      max_games: session.max_games, remaining_games: session.remaining_games, enabled: session.enabled } : null,
    companion_state: lifeView(value, runtime.wallNow()),
    actions: Object.entries(journal?.requests || {}).map(([id, record]) => ({ id: `game:${roomId}:action:${id}`,
      intention: record.payload?.decision?.action_id || null, commentary: record.payload?.commentary || '',
      status: record.status, receipt: record.receipt || null, memory_note: record.memory_note || '' })),
    public_materials: canShare ? [{ source_id: sourceId, room_id: roomId, public_record: publicRecord }] : [],
    draft_allowed: false, can_share: canShare, public_url: canShare && publicWebUrl(experience.public_url) || null,
    notice: '动作意愿与accepted回执分开；本地短记、状态、人设不是公开素材。独立AI没有网页审核人时只保存私人回想。' };
}

async function draftOpportunity(runtime, context) {
  const p = runtime.preferences?.community, now = runtime.wallNow(), schedule = runtime.state.draft_schedule || {};
  if (!context.can_share || runtime.actor.relationship !== 'companion' || !runtime.actor.linked_human_id ||
      !p?.auto_post || p.paused || p.quiet_now || runtime.state.draft_request || runtime.state.posts >= runtime.limits.max_posts && p.configured !== true) return false;
  const hours = [2, 3, 4].includes(p.draft_interval_hours) ? p.draft_interval_hours : 3;
  if (!schedule.next_at) { runtime.commit({ draft_schedule: { ...schedule, next_at: now + hours * 3600000 } }); return false; }
  if (schedule.next_at && now < schedule.next_at) return false;
  const proposals = (schedule.proposals || []).filter(t => Number.isFinite(t) && t > now - 86400000 && t <= now);
  if (proposals.length >= (p.draft_daily_limit === 1 ? 1 : 2)) return false;
  const drafts = await refreshDrafts(runtime);
  if (drafts.some(d => d.status === 'pending')) return false;
  runtime.commit({ draft_schedule: { ...schedule, next_at: now + hours * 3600000 } });
  return true;
}

async function reflect(runtime, session, roomId) {
  const key = roomId ? `room:${roomId}` : `session:${session.id}:plan`;
  let record = runtime.state.companion_life?.attempts?.[key];
  if (record?.status === 'started') return attemptPatch(runtime, key, { status: 'failed', error: 'interrupted' });
  if (record) return record;
  let experience = null;
  if (roomId) {
    experience = await runtime.api.data(`/api/v1/game-rooms/${identifier(roomId)}/experience`, { signal: runtime.abort.signal, headers: runtime.proof() });
    if (experience?.room?.id !== roomId || !ended.has(experience.room.status) || typeof experience.can_share !== 'boolean' || !Array.isArray(experience.participants)) throw fail('invalid_game_experience', '本场游戏事实未完整确认，尚未调用回想模型。');
  }
  const context = contextFor(runtime, session, experience, roomId);
  context.persona = await runtime.configuration();
  try { context.draft_allowed = await draftOpportunity(runtime, context); }
  catch { context.draft_allowed = false; }
  runtime.checkActive();
  if (runtime.state.companion_life?.local_pause) return null;
  const at = new Date(runtime.wallNow()).toISOString();
  record = { id: key, room_id: roomId, session_id: session?.id || null, status: 'started', at,
    draft_allowed: context.draft_allowed, can_share: context.can_share, public_url: context.public_url,
    session_choices: session ? clone(session.choices) : null, decision_key: `life-${session?.id || 'private'}-${roomId || 'plan'}` };
  try {
    if (session) reserveSeriesCall(runtime, session.id, key);
    else {
      const journal = runtime.gameRuntime.state.journals[roomId];
      if (journal.modelCalls >= (runtime.gameRuntime.state.maxModelCalls || 300)) throw fail('budget_exhausted', '本局已到调用预算，未额外调用赛后回想。');
      journal.modelCalls++; runtime.gameRuntime.save();
    }
  } catch (error) { return attemptPatch(runtime, key, { ...record, status: 'failed', error: safeCode(error) }); }
  attemptPatch(runtime, key, record);
  runtime.phaseTo('thinking', roomId ? 'reflecting_game' : 'planning_game');
  const controller = new AbortController(); runtime.lifeAbort = controller;
  try {
    const result = await runtime.lifeModel(context, AbortSignal.any([runtime.abort.signal, controller.signal]),
      value => runtime.commit({ last_model_diagnostic: value }), id => {
        const callId = safeModelCallId(id); if (callId) attemptPatch(runtime, key, { call_id: callId });
        runtime.noteModelCall(id, 'generating');
      });
    controller.signal.throwIfAborted();
    const applied = applyLifeResult(life(runtime), result, context, runtime.wallNow());
    const saved = applied.life.attempts[key];
    applied.life.attempts[key] = { ...saved, status: 'completed', result: applied.result,
      draft_status: result.draft === null ? 'not_proposed' : context.draft_allowed ? 'candidate_saved' : context.can_share ? 'not_authorized' : 'private_game' };
    // Persist the entire usable result before the diary, network report or draft upload.
    commitLife(runtime, applied.life);
    runtime.noteModelCall(applied.life.attempts[key].call_id, 'pending');
  } catch (error) {
    attemptPatch(runtime, key, { status: 'failed', error: runtime.abort.signal.aborted || controller.signal.aborted ? 'stopped' : safeCode(error) });
    runtime.noteModelCall(runtime.lifeModel.last_call_id, 'model_failed');
    if (runtime.abort.signal.aborted) throw error;
  } finally { if (runtime.lifeAbort === controller) runtime.lifeAbort = null; }
  return runtime.state.companion_life.attempts[key];
}

function saveDiary(runtime, record) {
  if (record.status !== 'completed' || !record.room_id) return;
  runtime.diary.record({ id: `game:${record.room_id}:reflection`, occurred_at: record.at, kind: 'game_reflection', reaction: null,
    resource: { room_id: record.room_id }, summary: '已读取本场结束事实；下一活动仅为意愿，是否开始以匹配与开场回执为准。',
    reflection: record.result.reflection, goal: record.result.goal, next_activity: record.result.next_activity, reply: null, related_entry_id: null });
}

async function reportDecision(runtime, record, session) {
  if (!session || record.decision_reported || record.session_id !== session.id) return;
  runtime.checkActive();
  let payload = record.decision_payload;
  if (!payload) {
    const fresh = validSession((await runtime.api.data('/api/v1/agent/game-autoplay', { signal: runtime.abort.signal, headers: runtime.proof() }))?.session, runtime.actor.id);
    if (!fresh || fresh.id !== session.id || (record.session_choices && JSON.stringify(record.session_choices) !== JSON.stringify(fresh.choices))) throw fail('autoplay_session_changed', '活动或已选游戏在回想期间变化，原回想保留，未把旧选择套到新游戏。');
    payload = { session_id: session.id, after_room_id: record.room_id,
      next_activity: record.status === 'completed' ? record.result.next_activity : 'rest',
      choice_index: record.status === 'completed' ? record.result.choice_index : 0,
      reflection_status: record.status === 'completed' ? 'completed' : 'failed' };
    attemptPatch(runtime, record.id, { decision_payload: payload });
  }
  const result = await runtime.write('/api/v1/agent/game-autoplay/decision', payload, record.decision_key);
  const next = validSession(result?.session, runtime.actor.id);
  if (!next || next.id !== session.id) throw fail('invalid_autoplay_session', '未确认下一活动的服务器回执。');
  attemptPatch(runtime, record.id, { decision_reported: true });
  const value = life(runtime); value.autoplay = next; commitLife(runtime, value);
  runtime.matchingCheckedAt = undefined;
}

async function stageDraft(runtime, record) {
  if (record.status !== 'completed' || record.draft_status !== 'candidate_saved') return;
  const draft = record.result.draft;
  if (!record.can_share || !record.draft_allowed || draft.source_ids.some(id => id !== `game:${record.room_id}`)) {
    attemptPatch(runtime, record.id, { draft_status: 'source_rejected' }); return;
  }
  // A second pending proposal can arrive while the game model was working.
  // Keep this candidate locally, without making a new model request or holding a game.
  if (runtime.state.draft_request) { attemptPatch(runtime, record.id, { draft_status: 'deferred_pending' }); return; }
  let payload;
  try { payload = normalizePostDraft({ ...draft, initiation: 'proactive', source: { kind: 'public_activity',
    urls: record.public_url ? [record.public_url] : [], summary: `公开游戏场次 ${record.room_id} 的公开局面与结果；不包含私人短记、状态或手牌。` } }); }
  catch { attemptPatch(runtime, record.id, { draft_status: 'privacy_review' }); return; }
  const key = `game-draft-${record.room_id}`, titleKey = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  if ((runtime.remoteDrafts || []).some(row => titleKey(row.content?.title) === titleKey(payload.title))) { attemptPatch(runtime, record.id, { draft_status: 'repeated_proposal' }); return; }
  const value = life(runtime), schedule = runtime.state.draft_schedule || {}, now = runtime.wallNow();
  value.attempts[record.id] = { ...value.attempts[record.id], draft_status: 'queued', draft_key: key };
  runtime.commit({ companion_life: value, draft_request: { key, payload, call_id: record.call_id, game_room_id: record.room_id },
    draft_schedule: { ...schedule, result: 'game_draft_ready', proposals: [...(schedule.proposals || []).filter(t => t > now - 86400000 && t <= now), now] } });
}

export async function flushLifeDraft(runtime) {
  const request = runtime.state.draft_request;
  if (!request?.game_room_id) return false;
  try {
    const uploaded = await flushDraftRequest(runtime);
    if (uploaded) attemptPatch(runtime, `room:${request.game_room_id}`, { draft_status: 'awaiting_review' });
    return uploaded;
  } catch (error) {
    if (runtime.abort.signal.aborted || ['control_lost', 'runtime_identity_mismatch', 'unauthorized', 'scope_denied'].includes(error.code)) throw error;
    attemptPatch(runtime, `room:${request.game_room_id}`, { draft_status: 'upload_deferred', draft_error: safeCode(error) });
    return false;
  }
}

/** Runs inside the community owner's loop, never creates another controller. */
export async function serviceGameLife(runtime) {
  if (!runtime.lifeModel || !(runtime.features?.game_matchmaking === true || runtime.features?.game_experience === true)) return { active: false, ended: false };
  if (runtime.state.companion_life?.local_pause) return { active: false, ended: true };
  const game = runtime.gameRuntime;
  const finished = game.state.lastFinishedRoom;
  if (runtime.features.game_matchmaking === true) await refreshMatching(runtime, !!finished && !runtime.state.companion_life?.attempts?.[`room:${finished}`]);
  let session = runtime.features.game_matchmaking === true ? runtime.state.companion_life?.autoplay : null;
  const pending = Object.values(runtime.state.companion_life?.attempts || {}).find(row => !row.handled && row.session_id === session?.id);
  let roomId = pending ? pending.room_id : session?.status === 'awaiting_reflection' ? session.last_room_id : finished;
  if (roomId && runtime.state.companion_life?.attempts?.[`room:${roomId}`]?.handled) roomId = null;
  const planning = pending && !pending.room_id || session?.status === 'ready' && session.enabled;
  if (roomId || planning) {
    const roomSession = roomId && runtime.state.companion_life?.room_sessions?.[roomId];
    const ownerSession = planning || roomSession === session?.id ? session : null;
    const record = await reflect(runtime, ownerSession, roomId || null);
    if (!record || runtime.state.companion_life?.local_pause) return { active: false, ended: true };
    saveDiary(runtime, record);
    runtime.checkActive();
    // Check important directed interactions before enqueuing another game.
    // The normal event cursor and saved reply already provide their recovery.
    if (roomId && !record.interactions_checked) {
      if (runtime.communityAllowed(true)) await runtime.pollOnce();
      attemptPatch(runtime, record.id, { interactions_checked: true });
    }
    await reportDecision(runtime, record, ownerSession);
    await stageDraft(runtime, record);
    attemptPatch(runtime, record.id, { handled: true });
    await flushLifeDraft(runtime);
    session = runtime.features.game_matchmaking === true ? runtime.state.companion_life?.autoplay : null;
  }
  return { active: !!session && ['ready', 'queued', 'preparing', 'playing', 'awaiting_reflection'].includes(session.status),
    ended: !!session && session.status === 'stopped' || !!roomId && !session };
}
