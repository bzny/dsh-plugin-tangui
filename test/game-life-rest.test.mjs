import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeApi, atomicState, fail, readState } from '../lib/runtime-api.js';
import { LocalDiary } from '../lib/local-diary.js';
import { newLife } from '../lib/companion-life.js';
import { CompanionMind } from '../lib/companion-mind.js';
import { pauseAutoplay, serviceGameLife } from '../lib/game-life-runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const clone = value => structuredClone(value);
const choice = { game_id: 'fixture-game', settings: { player_count: 2 } };
const counts = session => [session.id, session.started_games, session.completed_games, session.max_games, session.remaining_games];
const priorFeelings = value => Object.fromEntries(['values', 'updated_at', 'baseline', 'baseline_source', 'impressions'].map(k => [k, clone(value[k])]));
const decision = context => ({
  reflection: context.phase === 'resume' ? '休息了一会儿，可以考虑下一场。' : '虽然输了，但这一场的变化很有意思。',
  state: context.phase === 'resume' ? { mood: 99, interest: 100, pressure: 1 } : { mood: 64, interest: 72, pressure: 40 },
  baseline: context.phase === 'resume' ? null : { mood: 55, interest: 60, pressure: 40 },
  goal: '下次留意同桌的节奏。', note: '有自己的节奏。', impressions: [],
  next_activity: context.phase === 'resume' ? 'continue' : 'rest', choice_index: 0, draft: null,
  ...(context.phase === 'resume' ? {} : { rest_minutes: 1 }),
  appraisal: { summary: '仍然愿意尝试', reflection: '发现了值得回顾的细节。', delta: { mood: 6, pressure: -2 },
    activities: { play: 80 }, growth: { trait: 'competitiveness', direction: 1, reason: '这次输赢没有妨碍对游戏的兴趣。' } },
});

function fixture(t, { model, maxCalls = 20 } = {}) {
  const root = join(ROOT, `game-life-rest-${randomUUID()}`); mkdirSync(root, { recursive: true });
  const path = join(root, 'state.json'); let now = Date.parse('2026-11-01T04:00:00Z');
  const remote = { session: { id: 'session-fixture', actor_id: 'fixture-ai', enabled: true, choices: [choice], max_games: 3,
    started_games: 1, completed_games: 1, status: 'awaiting_reflection', current_ticket_id: null,
    last_room_id: 'room-1', remaining_games: 2, decision_revision: 2, resting_until: null, resting_activity: null },
    calls: [], models: [], reads: [], receipts: new Map(), loseDecision: false, localStops: 0, interactions: 0 };
  const make = () => {
    const initial = newLife(now);
    initial.series['session-fixture'] = { calls: 3, reservations: { 'action:1': true, 'action:2': true, 'action:3': true } };
    initial.room_sessions['room-1'] = 'session-fixture';
    const r = { state: readState(path) || { model_calls: 4, posts: 0, companion_life: initial }, stateFile: path,
      actor: { id: 'fixture-ai', name: '测试伙伴', kind: 'ai', relationship: 'companion', linked_human_id: 'fixture-human' },
      gameRuntime: { state: { maxModelCalls: maxCalls, lastFinishedRoom: 'room-1', journals: { 'room-1': { modelCalls: 3, requests: {} } } },
        save() {}, async stopCurrent() { remote.localStops++; } },
      features: { game_matchmaking: true, game_autoplay_rest: true }, mode: 'watch', running: () => true,
      abort: new AbortController(), preferences: { community: { auto_post: false }, diary: {} }, limits: { max_model_calls: 10, max_posts: 1 },
      wallNow: () => now, binding: () => ({ baseUrl: 'https://community.example' }),
      commit(patch) { this.state = { ...this.state, ...patch }; atomicState(path, this.state); },
      diary: new LocalDiary({ directory: join(root, 'diary'), baseUrl: 'https://community.example', actorId: 'fixture-ai' }),
      checkActive() { this.abort.signal.throwIfAborted(); }, phaseTo() {}, noteModelCall() {},
      proof() { return { 'X-AI-Instance-ID': 'fixture-instance', 'X-AI-Control-Epoch': '1' }; },
      async configuration() { return { description: 'PRIVATE_PERSONA' }; },
      communityAllowed() { return true; }, async pollOnce() { remote.interactions++; },
      async lifeModel(context, signal) { remote.models.push(clone(context)); return model ? model(context, signal) : decision(context); },
      api: { async data(endpoint, options) {
        remote.reads.push(endpoint); assert.equal(options.headers['X-AI-Control-Epoch'], '1');
        if (endpoint === '/api/v1/agent/game-autoplay') return { session: clone(remote.session) };
        if (endpoint === '/api/v1/game-matchmaking') return { tickets: [] };
        if (endpoint === '/api/v1/game-rooms/room-1/experience') return {
          room: { id: 'room-1', status: 'finished' }, participants: [{ actor_id: 'fixture-ai', name: '自己' }, { actor_id: 'other', name: '同桌' }],
          public_view: { events: ['同桌公开宣布加注。'] }, public_result: { winner: 'other' }, can_share: false, public_url: null,
        };
        assert.fail(`unexpected read ${endpoint}`);
      } },
      async write(endpoint, payload, key) {
        assert.equal(endpoint, '/api/v1/agent/game-autoplay/decision');
        remote.calls.push({ path: endpoint, payload: clone(payload), key });
        let receipt = remote.receipts.get(key);
        if (!receipt) {
          const s = remote.session, revision = payload.decision_revision;
          assert.equal(payload.session_id, s.id); assert.equal(payload.after_room_id, s.last_room_id);
          if (revision !== undefined && revision !== s.decision_revision) throw fail('autoplay_decision_changed', 'changed');
          if (!['ready', 'awaiting_reflection', 'resting'].includes(s.status)) throw fail('autoplay_decision_outdated', 'outdated');
          if (s.status === 'resting') {
            if (revision === undefined) throw fail('autoplay_revision_required', 'missing');
            if (Date.parse(s.resting_until) > now) throw fail('autoplay_still_resting', 'early');
          }
          if (payload.rest_until) {
            assert.ok(Number.isSafeInteger(revision)); assert.ok(Date.parse(payload.rest_until) > now);
            assert.ok(['rest', 'community'].includes(payload.next_activity));
          }
          const reason = payload.reflection_status === 'failed' ? 'reflection_failed' : !s.enabled ? 'disabled' :
            s.max_games !== null && s.started_games >= s.max_games ? 'max_games_reached' :
              !payload.rest_until && ['rest', 'community'].includes(payload.next_activity) ? payload.next_activity : null;
          remote.session = { ...s, decision_revision: s.decision_revision + 1, enabled: !reason,
            status: reason ? 'stopped' : payload.rest_until ? 'resting' : 'queued', stop_reason: reason,
            resting_until: !reason && payload.rest_until || null, resting_activity: !reason && payload.rest_until ? payload.next_activity : null };
          receipt = { session: clone(remote.session) }; remote.receipts.set(key, receipt);
        }
        if (remote.loseDecision) { remote.loseDecision = false; throw fail('network_error', 'lost response'); }
        return clone(receipt);
      },
    };
    r.mind = new CompanionMind({ directory: join(root, 'mind'), identity: () => ({ actor_id: r.actor.id,
      base_url: 'https://community.example', memory_dir: join(root, 'persona') }), now: () => now, legacy: () => r.state.companion_life });
    return r;
  };
  const r = make();
  r.mind.configure({ expected_actor_id: r.actor.id, expected_base_url: 'https://community.example', settings: { enabled: true } });
  t.after(() => {
    const child = relative(ROOT, resolve(root)); assert.ok(child && !child.startsWith('..') && !child.includes(':'));
    rmSync(root, { recursive: true });
  });
  return { r, remote, restart: make, advance(ms) { now += ms; } };
}

test('rest expires into one new choice with the same session, game allowance and cumulative budget', async t => {
  const f = fixture(t), originalCounts = counts(f.remote.session);
  await serviceGameLife(f.r);
  assert.equal(f.remote.session.status, 'resting'); assert.equal(f.remote.session.decision_revision, 3);
  assert.deepEqual(counts(f.remote.session), originalCounts); assert.equal(f.r.state.companion_life.series['session-fixture'].calls, 4);
  const legacy = priorFeelings(f.r.state.companion_life), signals = clone(f.r.mind.load().signals);
  f.advance(59999); const r = f.restart();
  assert.deepEqual(await serviceGameLife(r), { active: true, ended: false });
  assert.equal(f.remote.models.length, 1); assert.equal(f.remote.calls.length, 1);
  f.advance(1); const recovered = r.mind.viewCurrent().values;
  await serviceGameLife(r);
  assert.equal(f.remote.session.status, 'queued'); assert.deepEqual(counts(f.remote.session), originalCounts);
  assert.equal(f.remote.models.length, 2); assert.equal(f.remote.models[1].phase, 'resume'); assert.equal(f.remote.models[1].draft_allowed, false);
  assert.equal(f.remote.calls[1].payload.decision_revision, 3); assert.equal(f.remote.calls[1].payload.reflection_status, 'completed');
  assert.equal(f.remote.calls[1].payload.rest_until, undefined);
  assert.equal(r.state.companion_life.series['session-fixture'].calls, 5); assert.equal(r.state.model_calls, 4);
  assert.deepEqual(priorFeelings(r.state.companion_life), legacy, 'resume must not overwrite old feelings, decay timestamp or impressions');
  assert.deepEqual(r.mind.viewCurrent().values, recovered, 'resume must not apply the old win/loss delta again');
  assert.deepEqual(r.mind.load().signals, signals, 'resume must not add old win/loss evidence to personality growth');
  assert.equal(r.mind.load().events.filter(e => e.source === 'game').length, 1);
  assert.equal(r.mind.load().events.filter(e => e.source === 'rest').length, 1);
  assert.equal([...r.diary.entries()].filter(e => e.kind === 'game_reflection').length, 1);
  assert.equal(f.remote.interactions, 1);
  await serviceGameLife(f.restart()); assert.equal(f.remote.models.length, 2); assert.equal(f.remote.calls.length, 2);
});

test('exhausted resume budget sends the revision and stops, without model dispatch or a new rest deadline', async t => {
  const f = fixture(t, { maxCalls: 4 }); await serviceGameLife(f.r); f.advance(60000);
  const before = priorFeelings(f.r.state.companion_life), r = f.restart();
  assert.deepEqual(await serviceGameLife(r), { active: false, ended: true });
  assert.equal(f.remote.models.length, 1); assert.equal(f.remote.session.stop_reason, 'reflection_failed');
  assert.deepEqual(f.remote.calls.at(-1).payload, { session_id: 'session-fixture', after_room_id: 'room-1',
    next_activity: 'rest', choice_index: 0, reflection_status: 'failed', decision_revision: 3 });
  assert.equal(r.state.companion_life.attempts['session:session-fixture:resume:3'].error, 'budget_exhausted');
  assert.equal(r.state.companion_life.series['session-fixture'].calls, 4); assert.deepEqual(priorFeelings(r.state.companion_life), before);
  await serviceGameLife(f.restart()); assert.equal(f.remote.models.length, 1); assert.equal(f.remote.calls.length, 2);
});

test('failed resume keeps its technical cause private and does not become another rest or negative emotion', async t => {
  const f = fixture(t, { model: context => {
    if (context.phase === 'resume') throw Object.assign(new Error('PRIVATE_UPSTREAM_FAILURE'), { code: 'runtime_model_timeout' });
    return decision(context);
  } });
  await serviceGameLife(f.r); const before = priorFeelings(f.r.state.companion_life), events = f.r.mind.load().events.length;
  f.advance(60000); await serviceGameLife(f.r);
  assert.equal(f.remote.session.status, 'stopped'); assert.equal(f.remote.calls.at(-1).payload.decision_revision, 3);
  assert.equal(f.remote.calls.at(-1).payload.rest_until, undefined);
  assert.deepEqual(priorFeelings(f.r.state.companion_life), before); assert.equal(f.r.mind.load().events.length, events);
  const attempt = f.r.state.companion_life.attempts['session:session-fixture:resume:3'];
  assert.equal(attempt.error, 'runtime_model_timeout'); assert.doesNotMatch(JSON.stringify(f.r.state), /PRIVATE_UPSTREAM_FAILURE/);
  await serviceGameLife(f.restart()); assert.equal(f.remote.models.length, 2);
});

test('local stop during rest persists across restart and expiry without resetting allowance or budget', async t => {
  const f = fixture(t); await serviceGameLife(f.r); const originalCounts = counts(f.remote.session);
  assert.equal(await pauseAutoplay(f.r), true); assert.equal(f.remote.localStops, 1); assert.equal(f.r.abort.signal.aborted, false);
  f.advance(120000); const readCount = f.remote.reads.length, r = f.restart();
  assert.deepEqual(await serviceGameLife(r), { active: false, ended: true });
  assert.equal(f.remote.reads.length, readCount); assert.equal(f.remote.models.length, 1); assert.equal(f.remote.calls.length, 1);
  assert.equal(r.state.companion_life.series['session-fixture'].calls, 4); assert.deepEqual(counts(f.remote.session), originalCounts);
});

test('manual stop while resume model is running discards its late result and never rematches', async t => {
  let release;
  const f = fixture(t, { model: context => context.phase === 'resume' ? new Promise(resolve => { release = () => resolve(decision(context)); }) : decision(context) });
  await serviceGameLife(f.r); const before = priorFeelings(f.r.state.companion_life); f.advance(60000);
  const running = serviceGameLife(f.r);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await pauseAutoplay(f.r), true); release(); await running;
  assert.equal(f.remote.calls.length, 1); assert.equal(f.remote.session.status, 'resting');
  assert.equal(f.r.state.companion_life.attempts['session:session-fixture:resume:3'].error, 'stopped');
  assert.deepEqual(priorFeelings(f.r.state.companion_life), before);
  await serviceGameLife(f.restart()); assert.equal(f.remote.models.length, 2); assert.equal(f.remote.calls.length, 1);
});

test('website stop during resume rejects the stale decision and keeps the spent call counted', async t => {
  const f = fixture(t, { model: context => {
    if (context.phase === 'resume') f.remote.session = { ...f.remote.session, enabled: false, status: 'stopped', decision_revision: 4 };
    return decision(context);
  } });
  await serviceGameLife(f.r); f.advance(60000);
  await assert.rejects(serviceGameLife(f.r), { code: 'autoplay_session_changed' });
  assert.equal(f.remote.session.status, 'stopped'); assert.equal(f.remote.calls.length, 1);
  assert.equal(f.r.state.companion_life.series['session-fixture'].calls, 5);
  await assert.rejects(serviceGameLife(f.restart()), { code: 'autoplay_session_changed' });
  assert.equal(f.remote.models.length, 2);
});

test('lost rest and resume receipts replay exact saved requests with no repeated reflection, emotion or growth', async t => {
  const f = fixture(t); f.remote.loseDecision = true;
  await assert.rejects(serviceGameLife(f.r), { code: 'network_error' }); assert.equal(f.remote.session.status, 'resting');
  let r = f.restart(); await serviceGameLife(r);
  assert.equal(f.remote.models.length, 1); assert.deepEqual(f.remote.calls[0], f.remote.calls[1]);
  assert.equal(r.state.companion_life.attempts['room:room-1'].handled, true);
  f.advance(60000); f.remote.loseDecision = true;
  await assert.rejects(serviceGameLife(r), { code: 'network_error' }); assert.equal(f.remote.session.status, 'queued');
  const feelings = priorFeelings(r.state.companion_life), mind = clone(r.mind.load());
  r = f.restart(); await serviceGameLife(r);
  assert.equal(f.remote.models.length, 2); assert.deepEqual(f.remote.calls[2], f.remote.calls[3]); assert.equal(f.remote.receipts.size, 2);
  assert.equal(r.state.companion_life.attempts['session:session-fixture:resume:3'].handled, true);
  assert.deepEqual(priorFeelings(r.state.companion_life), feelings); assert.deepEqual(r.mind.load(), mind);
  assert.equal(r.state.companion_life.series['session-fixture'].calls, 5); assert.equal(f.remote.interactions, 1);
  assert.equal([...r.diary.entries()].filter(e => e.kind === 'game_reflection').length, 1);
  assert.doesNotMatch(JSON.stringify(f.remote.calls), /PRIVATE_|mood|pressure|competitiveness/);
});

test('malformed resting session fails visibly instead of waiting forever or generating an undefined revision', async t => {
  for (const patch of [{ decision_revision: undefined }, { resting_until: 'not-a-time' }]) {
    const f = fixture(t); f.remote.session = { ...f.remote.session, status: 'resting', resting_until: '2026-11-01T04:01:00Z', ...patch };
    await assert.rejects(serviceGameLife(f.r), { code: 'invalid_autoplay_session' });
    assert.equal(f.remote.models.length, 0); assert.equal(f.remote.calls.length, 0);
  }
});

test('rest API errors retain their safe codes without exposing server supplied text', async () => {
  for (const code of ['invalid_rest_until', 'invalid_decision_revision', 'autoplay_decision_changed', 'autoplay_revision_required', 'autoplay_still_resting', 'invalid_rest_decision']) {
    const api = new RuntimeApi({ baseUrl: 'https://community.example', fetchImpl: async () => Response.json(
      { error: { code, message: 'PRIVATE_SERVER_MESSAGE' } }, { status: code.startsWith('invalid_') ? 422 : 409 }) });
    await assert.rejects(api.data('/api/v1/agent/game-autoplay'), error => {
      assert.equal(error.code, code); assert.equal(error.http_rejected, true); assert.doesNotMatch(error.message, /PRIVATE_SERVER_MESSAGE/); return true;
    });
  }
});
