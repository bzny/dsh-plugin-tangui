import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicState, readState } from '../lib/runtime-api.js';
import { LocalDiary } from '../lib/local-diary.js';
import { newLife, lifeView, parseGameLife, applyLifeResult } from '../lib/companion-life.js';
import { serviceGameLife, reserveSeriesCall, reserveGameCall, publicLifeStatus, pauseAutoplay } from '../lib/game-life-runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const choice = { game_id: 'fixture-game', settings: { player_count: 2 } };
const decision = (patch = {}) => ({ reflection: '这场节奏很合我的性格，还想再试一次。', state: { mood: 70, interest: 80, pressure: 35 },
  baseline: null, goal: '下一场留意对手的公开动作。', note: '有兴致，也想放慢一点。', impressions: [], next_activity: 'continue', choice_index: 0, draft: null, ...patch });

function fixture(t, { model, session = true, share = true, companion = true } = {}) {
  const root = join(ROOT, `life-${randomUUID()}`); mkdirSync(root, { recursive: true });
  const path = join(root, 'state.json'); let now = Date.UTC(2026, 9, 30, 12);
  const remote = { session: session ? { id: 'session-fixture', actor_id: 'fixture-ai', enabled: true, choices: [choice], max_games: 2,
    started_games: 0, completed_games: 0, status: 'ready', current_ticket_id: null, last_room_id: null, remaining_games: 2 } : null,
    calls: [], models: [], drafts: [], tickets: [], receipts: new Map(), loseDecision: false, loseDraft: false, interactions: 0, localStops: 0 };
  const make = () => {
    const r = { state: readState(path) || { model_calls: 4, posts: 0, draft_schedule: { next_at: now - 1 }, companion_life: newLife(now) },
      actor: { id: 'fixture-ai', kind: 'ai', name: '测试伙伴', relationship: companion ? 'companion' : 'independent', linked_human_id: companion ? 'human' : null },
      gameRuntime: { state: { maxModelCalls: 20, journals: {} }, save() {}, async stopCurrent() { remote.localStops++; } }, features: { game_matchmaking: true }, mode: 'watch', running: () => true,
      abort: new AbortController(), preferences: { community: { auto_post: true, configured: true, draft_daily_limit: 2, draft_interval_hours: 3 }, diary: {} },
      limits: { max_model_calls: 10, max_posts: 1 }, wallNow: () => now, binding: () => ({ baseUrl: 'https://community.example' }),
      commit(patch) { this.state = { ...this.state, ...patch }; atomicState(path, this.state); },
      diary: new LocalDiary({ directory: join(root, 'diary'), baseUrl: 'https://community.example', actorId: 'fixture-ai' }),
      checkActive() { this.abort.signal.throwIfAborted(); }, phaseTo() {}, noteModelCall() {}, async refreshPreferences() {},
      proof() { return { 'X-AI-Instance-ID': 'fixture-instance', 'X-AI-Control-Epoch': '1' }; },
      async configuration() { return { description: 'PRIVATE_PERSONA', effective: { role: '热爱观察的伙伴' } }; },
      communityAllowed() { return true; }, async pollOnce() { remote.interactions++; remote.calls.push({ path: 'important_interactions' }); },
      async lifeModel(context, signal) { remote.models.push(context); return model ? model(context, signal) : decision(); },
      api: { async data(endpoint, options) {
        if (endpoint !== '/api/v1/agent/post-drafts') assert.equal(options.headers['X-AI-Control-Epoch'], '1');
        if (endpoint === '/api/v1/agent/game-autoplay') return { session: remote.session };
        if (endpoint === '/api/v1/game-matchmaking') return { tickets: remote.tickets };
        if (endpoint === '/api/v1/agent/post-drafts') return { drafts: remote.drafts };
        const id = endpoint.match(/^\/api\/v1\/game-rooms\/([^/]+)\/experience$/)?.[1];
        if (id) return { room: { id, status: 'finished' }, participants: [{ actor_id: 'fixture-ai', name: '自己' }, { actor_id: 'other', name: '同桌' }],
          public_view: { events: ['同桌公开宣布加注后停了一拍。'] }, public_result: { winner: 'other' }, can_share: share, public_url: `https://community.example/play/${id}` };
        assert.fail(`unexpected read ${endpoint}`);
      } },
      async write(endpoint, payload, key) {
        remote.calls.push({ path: endpoint, payload: structuredClone(payload), key });
        if (endpoint === '/api/v1/agent/game-autoplay/decision') {
          assert.deepEqual(Object.keys(payload).sort(), ['session_id', 'after_room_id', 'next_activity', 'choice_index', 'reflection_status'].sort());
          let receipt = remote.receipts.get(key);
          if (!receipt) {
            const continuing = ['continue', 'switch_game'].includes(payload.next_activity) && payload.reflection_status === 'completed' && remote.session.enabled;
            remote.session = { ...remote.session, status: continuing ? 'queued' : 'stopped', enabled: continuing,
              stop_reason: payload.reflection_status === 'failed' ? 'reflection_failed' : continuing ? null : payload.next_activity };
            receipt = { session: structuredClone(remote.session) }; remote.receipts.set(key, receipt);
          }
          if (remote.loseDecision) { remote.loseDecision = false; throw Object.assign(new Error('lost'), { code: 'network_error' }); }
          return receipt;
        }
        if (endpoint === '/api/v1/agent/post-drafts') {
          let row = remote.drafts.find(d => d.key === key);
          if (!row) { row = { id: `draft-${remote.drafts.length}`, key, status: 'pending', content: payload }; remote.drafts.push(row); }
          if (remote.loseDraft) { remote.loseDraft = false; throw Object.assign(new Error('lost'), { code: 'network_error' }); }
          return row;
        }
        if (endpoint.endsWith('/cancel')) {
          const id = endpoint.split('/').at(-2), row = remote.tickets.find(item => item.id === id);
          assert.ok(['queued', 'preparing'].includes(row.status)); row.status = 'cancelled'; return { ticket: row };
        }
        assert.fail(`unexpected write ${endpoint}`);
      } };
    return r;
  };
  const r = make();
  const finish = (runtime = r, id = 'room-1') => {
    runtime.gameRuntime.state.lastFinishedRoom = id;
    runtime.gameRuntime.state.journals[id] = { modelCalls: 3, requests: { 'turn-1': { status: 'accepted', payload: { decision: { action_id: 'pass' } },
      receipt: { status: 'accepted', request_id: 'turn-1' }, memory_note: 'PRIVATE_NOTE' } } };
    if (remote.session) {
      remote.session = { ...remote.session, enabled: true, status: 'awaiting_reflection', last_room_id: id, started_games: 1, completed_games: 1, remaining_games: 1 };
      const value = structuredClone(runtime.state.companion_life); value.room_sessions[id] = remote.session.id; runtime.commit({ companion_life: value });
    }
    runtime.matchingCheckedAt = undefined;
  };
  t.after(() => { const child = relative(ROOT, resolve(root)); assert.ok(child && !child.startsWith('..') && !child.includes(':')); rmSync(root, { recursive: true }); });
  return { r, remote, finish, restart: make, advance(ms) { now += ms; } };
}

test('state decay approaches a personal baseline without adding experiences or changing it', () => {
  const l = newLife(0); l.values = { mood: 90, interest: 10, pressure: 70 };
  assert.deepEqual(lifeView(l, 6 * 3600000).values, { mood: 70, interest: 30, pressure: 60 });
  assert.equal(l.attempts && Object.keys(l.attempts).length, 0);
  assert.equal(l.values.mood, 90);
});
test('bad numeric values and ungrounded relationship impressions reject the result', () => {
  assert.throws(() => parseGameLife(JSON.stringify(decision({ state: { mood: 101, interest: 50, pressure: 50 } }))), { code: 'invalid_model_decision' });
  const context = { self: { id: 'me' }, choices: [choice], participants: [{ actor_id: 'other' }], evidence: [{ evidence_id: 'e', public_record: { text: '同桌说了你好。' } }] };
  assert.throws(() => applyLifeResult(newLife(0), decision({ impressions: [{ actor_id: 'other', impression: '他一定是好朋友', evidence_id: 'e', evidence_excerpt: '不存在的事实' }] }), context, 0));
  const valid = applyLifeResult(newLife(0), decision({ impressions: [{ actor_id: 'other', impression: '本场主动打了招呼', evidence_id: 'e', evidence_excerpt: '同桌说了你好' }] }), context, 0);
  assert.equal(valid.life.impressions[0].scope, 'this_game_only');
});
test('initial plan and game actions share one persistent series budget; no community counter change', async t => {
  const f = fixture(t); await serviceGameLife(f.r);
  assert.equal(f.remote.models.length, 1); assert.equal(f.remote.session.status, 'queued'); assert.equal(f.r.state.model_calls, 4);
  f.r.state.companion_life.room_sessions['room-1'] = 'session-fixture';
  reserveGameCall(f.r, 'room-1', 'turn-1'); reserveGameCall(f.r, 'room-1', 'turn-1');
  assert.equal(publicLifeStatus(f.r).series_calls, 2);
  const restarted = f.restart(); reserveSeriesCall(restarted, 'session-fixture', 'room:room-1');
  assert.equal(restarted.state.companion_life.series['session-fixture'].calls, 3);
});
test('finished game saves a private reflection and queues next game despite pending review', async t => {
  const f = fixture(t); f.finish(); f.remote.drafts.push({ id: 'older-draft', status: 'pending', content: { title: '旧稿' } });
  await serviceGameLife(f.r);
  assert.equal(f.remote.models[0].phase, 'reflection'); assert.equal(f.remote.models[0].draft_allowed, false);
  assert.equal(f.remote.models[0].actions[0].memory_note, 'PRIVATE_NOTE');
  assert.equal(f.remote.session.status, 'queued');
  assert.equal([...f.r.diary.entries()].filter(e => e.kind === 'game_reflection').length, 1);
  const reports = f.remote.calls.filter(c => c.path.endsWith('/decision')); assert.equal(reports.length, 1);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_|mood|reflection":"/);
  assert.equal(f.remote.calls[0].path, 'important_interactions');
  await serviceGameLife(f.r); assert.equal(f.remote.models.length, 1);
});
test('rest stops this activity and another service pass does not start a new round', async t => {
  const f = fixture(t, { model: () => decision({ next_activity: 'rest' }) }); f.finish();
  const result = await serviceGameLife(f.r); assert.equal(result.ended, true);
  assert.equal(f.remote.session.stop_reason, 'rest'); f.advance(30000);
  await serviceGameLife(f.r); assert.equal(f.remote.models.length, 1); assert.equal(f.remote.receipts.size, 1);
});
test('model failure keeps previous state and reports technical failure, without retry after restart', async t => {
  const f = fixture(t, { model: () => { throw Object.assign(new Error('private upstream raw text'), { code: 'runtime_model_timeout' }); } }); f.finish();
  await serviceGameLife(f.r);
  assert.deepEqual(f.r.state.companion_life.values, { mood: 50, interest: 50, pressure: 50 });
  assert.equal(f.remote.session.stop_reason, 'reflection_failed'); assert.equal(publicLifeStatus(f.r).last_reflection.next_activity, null);
  const r = f.restart(); await serviceGameLife(r); assert.equal(f.remote.models.length, 1);
  assert.doesNotMatch(JSON.stringify(r.state), /private upstream raw text/);
});
test('interrupted dispatched reflection becomes explicit failure and is never regenerated', async t => {
  const f = fixture(t); f.finish();
  const value = structuredClone(f.r.state.companion_life); value.attempts['room:room-1'] = { id: 'room:room-1', room_id: 'room-1', session_id: 'session-fixture',
    at: new Date(f.r.wallNow()).toISOString(), status: 'started', decision_key: 'life-session-fixture-room-1' }; f.r.commit({ companion_life: value });
  await serviceGameLife(f.restart()); assert.equal(f.remote.models.length, 0); assert.equal(f.remote.session.stop_reason, 'reflection_failed');
});
test('lost initial decision response replays original key after restart without a second model call', async t => {
  const f = fixture(t); f.remote.loseDecision = true;
  await assert.rejects(serviceGameLife(f.r)); assert.equal(f.remote.session.status, 'queued');
  await serviceGameLife(f.restart());
  const writes = f.remote.calls.filter(c => c.path.endsWith('/decision'));
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(f.remote.models.length, 1); assert.equal(f.remote.receipts.size, 1);
});
test('public draft saves before uploading, lost response does not block continuation or duplicate draft', async t => {
  const f = fixture(t, { model: context => decision({ draft: { title: '一场有趣的对局', body: '公开局面中，同桌在加注后停了一拍。', topics: ['游戏'], source_ids: [`game:${context.room_id}`] } }) });
  f.finish(); f.remote.loseDraft = true; await serviceGameLife(f.r);
  assert.equal(f.remote.session.status, 'queued'); assert.equal(f.remote.drafts.length, 1);
  assert.equal(f.r.state.draft_request.game_room_id, 'room-1');
  const r = f.restart(); const { flushLifeDraft } = await import('../lib/game-life-runtime.js'); await flushLifeDraft(r);
  assert.equal(f.remote.drafts.length, 1); assert.equal(f.remote.models.length, 1); assert.equal(r.state.draft_request, null);
  assert.doesNotMatch(JSON.stringify(f.remote.drafts), /PRIVATE_|mood|pressure/);
});
test('private games and independent AIs keep reflections local without upload', async t => {
  for (const option of [{ share: false }, { companion: false }]) {
    const f = fixture(t, { ...option, model: context => decision({ draft: { title: '不该上传', body: '候选仍保留本地供解释。', topics: [], source_ids: [`game:${context.room_id}`] } }) });
    f.finish(); await serviceGameLife(f.r); assert.equal(f.remote.drafts.length, 0); assert.equal(f.remote.models[0].draft_allowed, false);
    assert.equal(f.r.state.companion_life.attempts['room:room-1'].status, 'completed');
  }
});
test('exhausted autonomous budget records no false desire and does not call model', async t => {
  const f = fixture(t); f.r.gameRuntime.state.maxModelCalls = 1; reserveSeriesCall(f.r, 'session-fixture', 'action:old'); f.finish();
  await serviceGameLife(f.r); assert.equal(f.remote.models.length, 0); assert.equal(f.remote.session.stop_reason, 'reflection_failed');
  assert.equal(publicLifeStatus(f.r).last_reflection.error, 'budget_exhausted');
});
test('ordinary invitation reflection uses its existing per-game budget, not series or community budget', async t => {
  const f = fixture(t, { session: false, model: () => decision({ next_activity: 'community' }) }); f.finish();
  await serviceGameLife(f.r); assert.equal(f.r.gameRuntime.state.journals['room-1'].modelCalls, 4);
  assert.equal(f.r.state.model_calls, 4); assert.deepEqual(f.r.state.companion_life.series, {}); assert.equal(f.remote.receipts.size, 0);
});
test('ordinary game experience works while matchmaking is disabled', async t => {
  const f = fixture(t, { session: false, model: () => decision({ next_activity: 'community' }) }); f.finish();
  f.r.features = { game_experience: true, game_matchmaking: false };
  await serviceGameLife(f.r); assert.equal(f.remote.models.length, 1); assert.equal(f.remote.models[0].phase, 'reflection');
});

test('pending update does not plan the next game before the local final snapshot arrives', async t => {
  const f = fixture(t); f.finish();
  f.r.updateRequested = true; f.r.gameInProgress = () => true;
  const waiting = await serviceGameLife(f.r);
  assert.equal(waiting.active, true); assert.equal(f.remote.models.length, 0);
  assert.equal(f.remote.calls.some(row => row.path.endsWith('/decision')), false);
  f.r.gameInProgress = () => false;
  await serviceGameLife(f.r);
  assert.equal(f.remote.models.length, 1);
});
test('local autoplay stop cancels only waiting tickets and persists the pause across restart', async t => {
  const f = fixture(t); await serviceGameLife(f.r);
  f.remote.tickets = ['queued', 'preparing', 'playing'].map(status => ({ id: `ticket-${status}`, status, autoplay_session_id: 'session-fixture', members: [{ actor_id: 'fixture-ai' }] }));
  assert.equal(await pauseAutoplay(f.r), true); assert.equal(f.remote.localStops, 1);
  assert.deepEqual(f.remote.tickets.map(row => row.status), ['cancelled', 'cancelled', 'playing']);
  assert.equal(f.r.abort.signal.aborted, false); assert.equal(f.r.gameRuntime.participationPaused, true);
  const restarted = f.restart(); assert.deepEqual(await serviceGameLife(restarted), { active: false, ended: true });
  assert.equal(f.remote.models.length, 1); assert.equal(f.remote.receipts.size, 1);
});
test('local stop during a life call prevents its late next-game report and keeps community control alive', async t => {
  let release; const f = fixture(t, { model: () => new Promise(resolve => { release = resolve; }) });
  const task = serviceGameLife(f.r);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await pauseAutoplay(f.r), true); release(decision()); await task;
  assert.equal(f.remote.receipts.size, 0); assert.equal(f.r.abort.signal.aborted, false);
  assert.equal(f.r.state.companion_life.attempts['session:session-fixture:plan'].error, 'stopped');
});
test('changed authorized choices cannot reinterpret a model choice index', async t => {
  const f = fixture(t, { model: () => { f.remote.session.choices = [{ game_id: 'different-game', settings: { player_count: 2 } }]; return decision(); } });
  await assert.rejects(serviceGameLife(f.r), { code: 'autoplay_session_changed' });
  assert.equal(f.remote.models.length, 1); assert.equal(f.remote.receipts.size, 0);
  assert.equal(f.r.state.companion_life.attempts['session:session-fixture:plan'].status, 'completed');
});
