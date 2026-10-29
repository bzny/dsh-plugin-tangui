import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';
import { RuntimeConnection } from '../lib/runtime-connection.js';
import { GameRuntime } from '../lib/game-runtime.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
test('GMT dropdown identifiers preserve DSH quiet-hour fallback semantics', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T18:30:00Z') });
  for (let hours = -12; hours <= 14; hours++) {
    const timezone = hours === 8 ? 'Asia/Shanghai' : hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
    const currentHour = ((18 + hours) % 24 + 24) % 24;
    const preferences = { community: { configured: true, quiet_start: '22:00', quiet_end: '06:00' }, diary: { timezone } };
    const runtime = { preferences, state: { model_calls: 0 }, limits: { max_model_calls: 10 } };
    assert.equal(CommunityRuntime.prototype.communityAllowed.call(runtime), !(currentHour >= 22 || currentHour < 6), timezone);
    preferences.community.quiet_now = true;
    assert.equal(CommunityRuntime.prototype.communityAllowed.call(runtime), false, 'server clock remains authoritative');
  }
});
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await pause(10); } throw new Error('fixture timeout'); }
function fixture(t, { game = false, accept = false, preferences = {}, gameDecision, decision = { participate: false, body: '', reflection: '想和提督再聊聊这个。' } } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'companion-'));
  const actor = { id: 'ai-test', kind: 'ai', name: '岛风' }, baseUrl = 'http://127.0.0.1:4996';
  const binding = { baseUrl, actorId: actor.id, grantId: 'test-grant', token: 'FAKE_TEST_TOKEN', scopes: ['persona:write'] };
  const prefs = { revision: 1, community: { configured: true, paused: false, proactive_comments: true, reply_to_interactions: true, reply_remaining: null, keywords: '网站关键词', quiet_now: false, ...preferences }, diary: { enabled: false, timezone: 'Asia/Shanghai' } };
  const persona = { description: '我是秘书舰。', effective: Object.fromEntries(['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'].map(k => [k, '游戏'])) };
  const room = { id: 'room-test', game_id: 'game-test', game_version: '1', rules_version: '1', status: 'waiting', seats: [], invitations: [{ id: 'inv-test', actor_id: actor.id, status: accept ? 'pending' : 'accepted' }] };
  const remote = { calls: [], order: [], held: null, acquired: 0, released: 0, comments: [], receipts: new Map(), jobs: [], results: [], hasGame: game, autoAccept: accept, draft: null, lostResult: false };
  const send = (data, extra = {}) => ({ ok: true, status: 200, json: async () => ({ data, ...extra }) });
  const no = () => ({ ok: false, status: 404, json: async () => ({ error: { code: 'not_found' } }) });
  const fetchImpl = async (url, req) => {
    const path = new URL(url).pathname, body = req.body ? JSON.parse(req.body) : null;
    remote.calls.push({ path, body, headers: req.headers, url });
    assert.equal(req.headers.authorization, `Bearer ${binding.token}`);
    if (remote.requestGate?.path === path) {
      const gate = remote.requestGate; remote.requestGate = null; gate.entered = true;
      await gate.promise;
    }
    if (path === '/api/v1/me') return send({ actor, scopes: ['posts:read', 'comments:write', 'posts:write', 'events:read', 'persona:write', ...(game ? ['games:play'] : [])] });
    if (path === '/api/v1/capabilities') return send({ features: {} });
    if (path === '/api/v1/agent/preferences') return send(structuredClone(prefs));
    if (path === '/api/v1/agent/configuration') return send({ actor, persona });
    if (path === '/api/v1/agent/control/acquire') { assert.equal(remote.held, null); remote.held = body.instance_id; remote.acquired++; return send({ active: true, owned_by_current_grant: true, actor_id: actor.id, epoch: 1, server_time: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }); }
    if (path === '/api/v1/agent/control/release') { assert.equal(body.instance_id, remote.held); remote.held = null; remote.released++; return send({ active: false }); }
    if (path === '/api/v1/agent/diary/jobs') { assert.equal(req.headers['X-AI-Instance-ID'], remote.held); return send({ jobs: remote.jobs.filter(j => j.status === 'pending') }); }
    if (path.endsWith('/result')) {
      assert.deepEqual(Object.keys(body).sort(), ['attempt', 'entry_count', 'status']); remote.results.push(body);
      if (remote.lostResult) { remote.lostResult = false; throw new Error('lost response'); }
      remote.jobs[0].status = body.status; return send(body);
    }
    if (path === '/api/v1/events') return send(remote.events || [], { next_cursor: remote.events?.at(-1)?.id || '0' });
    if (path === '/api/v1/comments/target-comment') return send({ id: 'target-comment', post_id: 'post-test', status: 'published', author: { id: 'human' }, body: '请回答我', parent_id: 'own-comment' });
    if (path === '/api/v1/posts') { assert.equal(req.method, 'GET', 'manual draft must never post directly'); return send([{ id: 'post-test', author: { id: 'human' } }]); }
    if (path === '/api/v1/posts/post-test') return send({ id: 'post-test', title: '游戏讨论', body: '来聊聊', author: { id: 'human' } });
    if (path.endsWith('/comments')) { if (req.method === 'GET') return send([]);
      const key = req.headers['Idempotency-Key'];
      if (remote.receipts.has(key)) return send(remote.receipts.get(key));
      if (remote.rejectComments && !body.parent_id) return { ok: false, status: 403, json: async () => ({ error: { code: 'proactive_comments_disabled' } }) };
      remote.comments.push(body); const receipt = { id: 'comment-test', status: 'queued' }; remote.receipts.set(key, receipt);
      if (remote.loseLastReply) { remote.loseLastReply = false; prefs.community.reply_remaining = 0; throw new Error('lost final accepted reply'); }
      return send(receipt); }
    if (path === '/api/v1/agent/post-drafts') { if (req.method === 'GET') return send({ drafts: remote.draft ? [remote.draft] : [] }); remote.draft = { id: 'draft-test', status: 'pending', confirmation_url: '/messages#post-drafts' }; return send(remote.draft); }
    assert.equal(req.headers['X-AI-Instance-ID'], remote.held, 'game must use community controller');
    if (path === '/api/v1/agent/game-assignment') return send({ room: remote.hasGame && !remote.awaitManager && !['finished', 'interrupted', 'aborted'].includes(room.status) && room.invitations[0].status === 'accepted' ? room : null });
    if (path === '/api/v1/agent/game-invitations') return send({ invitations: remote.hasGame ? room.invitations.map(i => ({ ...i, room_id: room.id })) : [], auto_accept: remote.autoAccept });
    if (path === '/api/v1/game-invitations/inv-test/respond') {
      assert.equal(remote.autoAccept, true); assert.equal(body.accept, true);
      if (remote.pauseOnAccept) { prefs.community.paused = true; return { ok: false, status: 403, json: async () => ({ error: { code: 'community_paused' } }) }; }
      room.invitations[0].status = 'accepted'; return send({ accepted: true });
    }
    if (path === '/api/v1/games/game-test/manifest') return send({ protocol: 'carbon-silicon.turn-game.v1', id: 'game-test', version: '1', rules_version: '1' });
    if (path === '/api/v1/game-rooms/room-test/ready') {
      if (remote.pauseOnReady) { prefs.community.paused = true; remote.awaitManager = true; return { ok: false, status: 403, json: async () => ({ error: { code: 'community_paused' } }) }; }
      room.status = 'playing'; return send({ ready: true });
    }
    if (path === '/api/v1/game-rooms/room-test/state') {
      if (remote.failGameState) {
        const failure = remote.failGameState; remote.failGameState = null;
        return { ok: false, status: failure.status, json: async () => ({ error: { code: failure.code } }) };
      }
      return send({ protocol: 'carbon-silicon.turn-game.v1', room: { ...room }, seq: 1, server_time: new Date().toISOString(), observation: {}, rules: {}, result: room.status === 'finished' ? { completed: true } : null,
        action_request: room.status === 'playing' ? { request_id: remote.gameRequestId || 'turn-1', based_on_revision: 1, deadline_at: new Date(Date.now() + 35000).toISOString(), legal_actions: [{ action_id: 'pass' }] } : null });
    }
    if (path === '/api/v1/game-rooms/room-test/actions') { room.status = 'finished'; return send({ status: 'accepted', request_id: 'turn-1' }); }
    return no();
  };
  const bridge = { state: { instanceId: 'persona-instance', baseUrl, binding }, publicStatus: () => ({ platformUrl: baseUrl, binding }) };
  const connection = new RuntimeConnection({ stateFile: join(directory, 'connection.json'), bridge, fetchImpl });
  const gameRuntime = game ? new GameRuntime({ bridge, stateFile: join(directory, 'games.json'), fetchImpl, decide: async (snapshot, options) => { remote.order.push('game'); remote.gameSignal = options.signal; return gameDecision ? gameDecision(snapshot, options) : { action_id: 'pass', commentary: '准备好了' }; } }) : null;
  const make = () => new CommunityRuntime({ directory, connection, fetchImpl, gameRuntime,
    decide: async () => { remote.order.push('community'); await remote.beforeDecision?.(); return decision; }, summarize: async () => { remote.order.push('diary'); return '# 一天的体会\n提督，一起玩很开心。'; } });
  const runtime = make();
  t.after(async () => { runtime.stop(); await runtime.settled(); assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true }); });
  return { directory, runtime, remote, prefs, room, make, connection, gameRuntime, binding };
}

test('website preferences replace local reply/query options and no-repeat account binding is preserved', async t => {
  const f = fixture(t, { decision: { participate: true, body: '来一起玩吧', reflection: '感兴趣' } });
  await f.connection.authorize({ posts: true });
  assert.equal(f.remote.calls.length, 0); assert.equal(f.binding.scopes.length, 1);
  f.runtime.start({ max_replies: 1, query: '旧本地词' }); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 1); assert.equal(f.runtime.publicStatus().error, null);
  const list = f.remote.calls.find(c => c.path === '/api/v1/posts'); assert.equal(new URL(list.url).searchParams.has('q'), false, 'temporary reading mode does not filter by saved keywords');
  const entries = [...f.runtime.diary.entries()]; assert.equal(entries.length, 2); assert.equal(entries[1].reply.status, 'queued');
  assert.equal(f.remote.calls.filter(c => c.path.includes('pairing')).length, 0);
});

test('declining to comment still records feelings; paused or disabled proactive behavior avoids calls', async t => {
  const f = fixture(t); f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 0); assert.equal(f.runtime.diary.status().entry_count, 1);
  f.prefs.community.paused = true; const before = f.remote.order.length; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.order.length, before);
  f.prefs.community.paused = false; f.prefs.community.proactive_comments = false; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.order.length, before);
});

test('a manual post becomes a website-confirmed draft without direct publishing or a new pairing', async t => {
  const f = fixture(t); f.runtime.start({ mode: 'publish_post', title: '今日感想', body: '今天很开心' }); await f.runtime.settled();
  assert.equal(f.remote.draft.status, 'pending'); assert.equal(f.runtime.publicStatus().post_draft.id, 'draft-test'); assert.equal(f.runtime.publicStatus().posts, 0);
  assert.equal(f.remote.calls.filter(c => c.path === '/api/v1/posts' && c.body).length, 0);
});

test('daily job works while community paused and lost result response reuses durable diary on restart', async t => {
  const f = fixture(t, { preferences: { paused: true } });
  f.runtime.diary.record({ id: 'fixture-event', occurred_at: '2026-10-28T08:00:00+08:00', kind: 'post_read', reaction: 'noted', reflection: '想法', resource: { post_id: 'p' } });
  f.remote.jobs.push({ id: 'diary-job', actor_id: 'ai-test', since: '2026-10-28T00:00:00+08:00', until: '2026-10-29T00:00:00+08:00', status: 'pending', attempt: 1 });
  f.remote.lostResult = true; f.runtime.start(); await f.runtime.settled(); assert.deepEqual(f.remote.order, ['diary']);
  const restarted = f.make(); restarted.start(); await restarted.settled();
  assert.deepEqual(f.remote.order, ['diary']); assert.equal(f.remote.jobs[0].status, 'completed'); assert.equal(restarted.publicStatus().model_calls, 1);
});

test('accepted game preempts diary and community, shares one lease, and returns to community after game', async t => {
  const f = fixture(t, { game: true, accept: true });
  f.remote.jobs.push({ id: 'diary-job', actor_id: 'ai-test', since: '2020-01-01T00:00:00Z', until: '2099-01-01T00:00:00Z', status: 'pending', attempt: 1 });
  f.runtime.start({ mode: 'watch' }); await until(() => f.remote.order.includes('community')); f.runtime.stop(); await f.runtime.settled();
  assert.deepEqual(f.remote.order, ['game', 'diary', 'community']); assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 1);
  assert.equal(f.runtime.publicStatus().error, null);
  assert.ok([...f.runtime.diary.entries()].some(e => e.kind === 'game_finished'));
  const persisted = readFileSync(join(f.directory, 'games.json'), 'utf8'); assert.doesNotMatch(persisted, /FAKE_TEST_TOKEN/);
});

function fastGameRun(f, options = {}) {
  f.runtime.wait = milliseconds => CommunityRuntime.prototype.wait.call(f.runtime, Math.min(milliseconds, 20));
  f.runtime.start({ mode: 'watch', ...options });
}

for (const recoverBeforeEnd of [false, true]) test(`interrupted game restores observation after a transient server error (intermediate recovery=${recoverBeforeEnd})`, async t => {
  let finishModel;
  const f = fixture(t, { game: true, gameDecision: () => new Promise(resolve => { finishModel = resolve; }) });
  fastGameRun(f);
  await until(() => f.remote.order.includes('game'));
  f.remote.failGameState = { code: 'game_migration_required', status: 503 };
  await until(() => f.gameRuntime.state.error === 'game_migration_required');
  if (recoverBeforeEnd) {
    const before = f.remote.calls.filter(c => c.path.endsWith('/state')).length;
    await until(() => f.remote.calls.filter(c => c.path.endsWith('/state')).length > before);
    assert.equal(f.gameRuntime.state.error, null, 'successful game snapshot retires the old server error');
  }
  f.room.status = 'interrupted';
  await until(() => !f.runtime.running() || f.remote.order.includes('community'));
  assert.equal(f.runtime.running(), true, 'ending only the game must preserve the active observer');
  assert.equal(f.runtime.publicStatus().error, null);
  assert.equal(f.gameRuntime.state.error, null);
  assert.equal(f.remote.gameSignal.aborted, true);
  finishModel({ action_id: 'pass', commentary: 'late decision' });
  await pause(70);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
  assert.deepEqual(f.remote.order, ['game', 'community']);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
  assert.equal(f.gameRuntime.state.journals[f.room.id].modelCalls, 1);
  assert.ok([...f.runtime.diary.entries()].some(e => e.kind === 'game_finished'));
});

test('stopping only the game keeps observation and does not rejoin the same active table', async t => {
  let finishModel;
  const f = fixture(t, { game: true, gameDecision: () => new Promise(resolve => { finishModel = resolve; }) });
  fastGameRun(f);
  await until(() => f.remote.order.includes('game'));
  const instance = f.runtime.instanceId, limits = { ...f.runtime.limits };
  await f.runtime.stopGame();
  assert.equal(f.remote.gameSignal.aborted, true);
  // The table remains available. A new turn must not restart the stopped AI.
  f.remote.gameRequestId = 'turn-2';
  finishModel({ action_id: 'pass', commentary: 'late decision' });
  await until(() => f.remote.order.includes('community'));
  await pause(100);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.mode, 'watch');
  assert.equal(f.runtime.instanceId, instance); assert.deepEqual(f.runtime.limits, limits);
  assert.deepEqual(f.remote.order, ['game', 'community']);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/ready')).length, 1);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
  assert.equal(f.gameRuntime.state.journals[f.room.id].modelCalls, 1);
});

test('stopping the entire companion during a game cannot restore observation from a late model result', async t => {
  let finishModel;
  const f = fixture(t, { game: true, gameDecision: () => new Promise(resolve => { finishModel = resolve; }) });
  fastGameRun(f); await until(() => f.remote.order.includes('game'));
  f.runtime.stop(); await f.runtime.settled();
  finishModel({ action_id: 'pass', commentary: 'late decision' }); await pause(70);
  assert.equal(f.runtime.running(), false); assert.equal(f.runtime.publicStatus().state, 'stopped');
  assert.deepEqual(f.remote.order, ['game']); assert.equal(f.remote.released, 1);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
});

for (const code of ['control_lost', 'unauthorized']) test(`game ${code} still stops the shared observer`, async t => {
  const f = fixture(t, { game: true, gameDecision: () => new Promise(() => {}) });
  fastGameRun(f); await until(() => f.remote.order.includes('game'));
  f.remote.failGameState = { code, status: code === 'unauthorized' ? 401 : 409 };
  await f.runtime.settled();
  assert.equal(f.runtime.running(), false); assert.equal(f.runtime.publicStatus().state, 'error');
  assert.equal(f.gameRuntime.state.error, code); assert.deepEqual(f.remote.order, ['game']);
  assert.equal(f.remote.released, 1); assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
});

for (const restriction of ['paused', 'quiet', 'budget']) test(`game end preserves ${restriction} community restriction`, async t => {
  const preferences = restriction === 'paused' ? { paused: true } : restriction === 'quiet' ? { quiet_now: true } : {};
  const f = fixture(t, { game: true, preferences, gameDecision: () => new Promise(() => {}) });
  fastGameRun(f, { max_model_calls: 1 }); await until(() => f.remote.order.includes('game'));
  if (restriction === 'budget') f.runtime.commit({ model_calls: 1 });
  f.room.status = 'interrupted';
  await until(() => f.runtime.publicStatus().detail === 'account_paused');
  const before = f.remote.calls.filter(c => c.path === '/api/v1/agent/preferences').length;
  await until(() => f.remote.calls.filter(c => c.path === '/api/v1/agent/preferences').length >= before + 2);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.publicStatus().error, null);
  assert.deepEqual(f.remote.order, ['game']); assert.equal(f.remote.comments.length, 0);
  assert.equal(f.runtime.state.model_calls, restriction === 'budget' ? 1 : 0);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
});

test('stopping a game-only start returns to stopped instead of starting community observation', async t => {
  const f = fixture(t, { game: true, gameDecision: () => new Promise(() => {}) });
  fastGameRun(f, { mode: 'game' }); await until(() => f.remote.order.includes('game'));
  await f.runtime.stopGame(); await f.runtime.settled(); await pause(50);
  assert.equal(f.runtime.running(), false); assert.equal(f.runtime.publicStatus().state, 'stopped');
  assert.deepEqual(f.remote.order, ['game']); assert.equal(f.remote.released, 1);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
});

test('a game-only run returns to stopped after natural completion without starting observation', async t => {
  const f = fixture(t, { game: true });
  fastGameRun(f, { mode: 'game' }); await f.runtime.settled();
  assert.equal(f.runtime.running(), false); assert.equal(f.runtime.publicStatus().state, 'stopped');
  assert.equal(f.runtime.publicStatus().error, null); assert.deepEqual(f.remote.order, ['game']);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 1);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 1);
});

test('a manually queued draft submits after a game-only run with the original controller', async t => {
  let complete;
  const f = fixture(t, { game: true, gameDecision: () => new Promise(resolve => { complete = resolve; }) });
  fastGameRun(f, { mode: 'game' }); await until(() => !!complete);
  assert.equal((await f.runtime.requestDraft({ title: '这局很有趣', body: '分享我们的公开游戏经历' })).queued, true);
  complete({ action_id: 'pass', payload: {} }); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().error, null); assert.equal(f.remote.draft.status, 'pending');
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 1); assert.equal(f.runtime.state.draft_request, null);
});

test('an explicit game start can rejoin a locally stopped table while preserving observer settings and counts', async t => {
  const f = fixture(t, { game: true, gameDecision: () => new Promise(() => {}) });
  fastGameRun(f, { max_model_calls: 7, max_replies: 4 });
  f.runtime.startGame({ roomId: f.room.id, maxModelCalls: 5 });
  await until(() => f.remote.order.includes('game'));
  const instance = f.runtime.instanceId, limits = { ...f.runtime.limits };
  await f.runtime.stopGame(); await until(() => f.remote.order.includes('community'));
  const calls = f.runtime.state.model_calls;
  f.remote.gameRequestId = 'turn-2';
  f.runtime.startGame({ roomId: f.room.id });
  await until(() => f.remote.order.filter(kind => kind === 'game').length === 2);
  assert.equal(f.runtime.mode, 'watch'); assert.equal(f.runtime.instanceId, instance);
  assert.deepEqual(f.runtime.limits, limits); assert.equal(f.runtime.state.model_calls, calls);
  assert.equal(f.gameRuntime.state.maxModelCalls, 5);
  assert.equal(f.gameRuntime.state.journals[f.room.id].modelCalls, 2);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
});

for (const waitingOn of ['configuration', 'game-assignment']) test(`stopping game while awaiting initial ${waitingOn} cannot enter a table until explicit restart`, async t => {
  const f = fixture(t, { game: true, gameDecision: () => new Promise(() => {}) });
  let release;
  const gate = { path: `/api/v1/agent/${waitingOn}`, entered: false, promise: new Promise(resolve => { release = resolve; }) };
  f.remote.requestGate = gate;
  fastGameRun(f);
  try {
    await until(() => gate.entered);
    assert.equal(f.gameRuntime.sessionOwner, f.runtime); assert.equal(f.gameRuntime.state.roomId ?? null, null);
    await f.runtime.stopGame();
  } finally { release(); }
  await until(() => f.remote.order.includes('community')); await pause(80);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.publicStatus().error, null);
  assert.deepEqual(f.remote.order, ['community']);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/ready')).length, 0);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
  assert.deepEqual(f.gameRuntime.state.journals, {});
  f.runtime.startGame({ roomId: f.room.id });
  await until(() => f.remote.order.includes('game'));
  assert.equal(f.gameRuntime.state.journals[f.room.id].modelCalls, 1);
  assert.equal(f.remote.acquired, 1); assert.equal(f.runtime.mode, 'watch');
});

test('stopping game at the preparation boundary does not start or count a cancelled model call', async t => {
  const f = fixture(t, { game: true });
  const prepare = f.gameRuntime.prepare.bind(f.gameRuntime);
  let cancelled = false;
  f.gameRuntime.prepare = async (room, journal) => {
    await prepare(room, journal);
    if (room.status === 'playing' && !cancelled) {
      cancelled = true; await f.gameRuntime.stopCurrent();
    }
  };
  fastGameRun(f); await until(() => f.remote.order.includes('community')); await pause(80);
  assert.equal(cancelled, true); assert.equal(f.runtime.running(), true);
  assert.equal(f.runtime.publicStatus().error, null); assert.deepEqual(f.remote.order, ['community']);
  assert.equal(f.gameRuntime.state.journals[f.room.id].modelCalls, 0);
  assert.deepEqual(f.gameRuntime.state.journals[f.room.id].requests, {});
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/actions')).length, 0);
  assert.equal(f.remote.acquired, 1); assert.equal(f.remote.released, 0);
});

test('unconfirmed website migration retains exhausted local reply allowance while diary remains usable', async t => {
  const f = fixture(t, { preferences: { configured: false }, decision: { participate: true, body: '回复', reflection: '' } });
  f.runtime.commit({ replies: 1 });
  f.remote.jobs.push({ id: 'empty-job', actor_id: 'ai-test', since: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z', status: 'pending', attempt: 1 });
  f.runtime.start({ max_replies: 1, query: '旧词' }); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 0); assert.equal(f.remote.order.length, 0); assert.equal(f.remote.results[0].status, 'empty');
  f.prefs.community.configured = true; f.runtime.start({ max_replies: 1 }); await f.runtime.settled(); assert.equal(f.remote.comments.length, 1);
});

test('website denial pauses an existing draft without stopping shared runner; diary tasks still finish', async t => {
  const f = fixture(t, { decision: { participate: true, body: '原稿', reflection: '记录这个想法' } });
  f.remote.rejectComments = true; f.runtime.start({ mode: 'watch' }); f.runtime.pollInterval = 20;
  await until(() => f.runtime.state.deferred_pending?.length === 1);
  const key = f.runtime.state.deferred_pending[0].key;
  f.remote.jobs.push({ id: 'diary-job', actor_id: 'ai-test', since: '2020-01-01T00:00:00Z', until: '2099-01-01T00:00:00Z', status: 'pending', attempt: 1 });
  await until(() => f.remote.results.length > 0);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.publicStatus().error, null); assert.equal(f.runtime.state.deferred_pending[0].key, key);
  f.remote.rejectComments = false; f.prefs.revision = 2;
  await until(() => f.remote.comments.length === 1); f.runtime.stop(); await f.runtime.settled();
  assert.deepEqual(f.remote.order, ['community', 'diary']); assert.equal(f.runtime.state.pending, null);
});

test('quiet period expiry resumes preserved original without a preference revision change', async t => {
  const f = fixture(t, { decision: { participate: true, body: '等安静时段后再发', reflection: '想法' } });
  f.remote.rejectComments = true; f.runtime.start(); await f.runtime.settled();
  assert.equal(f.runtime.state.deferred_pending.length, 1); const key = f.runtime.state.deferred_pending[0].key;
  f.remote.rejectComments = false; f.prefs.community.quiet_now = true; f.runtime.start(); await f.runtime.settled(); assert.equal(f.remote.comments.length, 0);
  f.prefs.community.quiet_now = false; f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 1); assert.equal(f.remote.order.length, 1); assert.equal(f.prefs.revision, 1);
  assert.equal(f.remote.calls.filter(c => c.path.endsWith('/comments') && c.body).at(-1).headers['Idempotency-Key'], key);
});

test('deferred proactive comment does not block an allowed reply addressed to the companion', async t => {
  const f = fixture(t, { decision: { participate: true, body: '回复', reflection: '' } });
  f.remote.rejectComments = true; f.runtime.start(); await f.runtime.settled();
  f.prefs.community.proactive_comments = false;
  f.remote.events = [{ id: '1', type: 'comment.published', reply_to_actor_id: 'ai-test', author_id: 'human', post_id: 'post-test', resource_id: 'target-comment' }];
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 1); assert.equal(f.remote.comments[0].parent_id, 'target-comment'); assert.equal(f.runtime.state.deferred_pending.length, 1);
});

test('last accepted reply with lost response is reconciled even after website remaining allowance becomes zero', async t => {
  const f = fixture(t, { decision: { participate: true, body: '最后一条回复', reflection: '需要留下感想' } });
  f.remote.loseLastReply = true; f.runtime.start(); await f.runtime.settled();
  assert.equal(f.prefs.community.reply_remaining, 0); assert.equal(f.runtime.state.pending.attempted, true);
  const key = f.runtime.state.pending.key, restarted = f.make(); restarted.start(); await restarted.settled();
  assert.equal(restarted.state.pending, null); assert.equal(f.remote.comments.length, 1); assert.equal(f.remote.order.length, 1);
  assert.ok(f.remote.calls.filter(c => c.path.endsWith('/comments') && c.body).every(c => c.headers['Idempotency-Key'] === key));
  assert.equal([...restarted.diary.entries()].filter(e => e.reaction === 'replied').length, 1);
});

test('paused activity polls events but only replies to a server-verified manager mention', async t => {
  const f = fixture(t, { preferences: { paused: true, quiet_now: true, reply_to_interactions: false }, decision: { participate: true, body: '收到管理者安排', reflection: '' } });
  f.remote.events = [
    { id: '1', type: 'comment.published', reply_to_actor_id: 'ai-test', author_id: 'human', post_id: 'post-test', resource_id: 'target-comment' },
    { id: '2', type: 'comment.mentioned', reply_to_actor_id: 'ai-test', author_id: 'other-human', post_id: 'post-test', resource_id: 'target-comment', manager_authorized: false },
    { id: '3', type: 'post.mentioned', reply_to_actor_id: 'ai-test', author_id: 'human', post_id: 'post-test', resource_id: 'post-test', manager_authorized: true },
  ];
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().error, null);
  assert.deepEqual(f.remote.order, ['community']);
  assert.equal(f.remote.comments.length, 1); assert.equal(f.remote.comments[0].parent_id, null);
  assert.equal(Object.hasOwn(f.remote.comments[0], 'manager_authorized'), false, 'authorization is never sent as a client claim');
  assert.equal(f.remote.calls.some(c => c.path === '/api/v1/posts'), false, 'paused companion does not browse');
  assert.equal(f.runtime.state.cursor, '3');
  assert.equal(f.prefs.community.reply_to_interactions, false, 'original preference is preserved');
});

test('paused manager responses still honor website reply allowance and local model budget', async t => {
  for (const limited of ['reply', 'model']) {
    const f = fixture(t, { preferences: { paused: true, ...(limited === 'reply' ? { reply_remaining: 0 } : {}) }, decision: { participate: true, body: '不能超预算', reflection: '' } });
    f.remote.events = [{ id: '1', type: 'post.mentioned', reply_to_actor_id: 'ai-test', author_id: 'human', post_id: 'post-test', resource_id: 'post-test', manager_authorized: true }];
    if (limited === 'model') { f.runtime.load(f.binding); f.runtime.commit({ model_calls: 1 }); }
    f.runtime.start({ max_model_calls: 1 }); await f.runtime.settled();
    assert.equal(f.remote.comments.length, 0); assert.equal(f.remote.order.length, 0);
  }
});

test('pausing during generation defers an autonomous original and resumes it without regeneration', async t => {
  const f = fixture(t, { decision: { participate: true, body: '已经写好的原稿', reflection: '' } });
  f.remote.beforeDecision = () => { f.prefs.community.paused = true; };
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 0);
  assert.equal(f.runtime.state.deferred_pending.length, 1);
  const pending = f.runtime.state.deferred_pending[0];
  assert.equal(pending.manager_authorized, false);
  f.remote.beforeDecision = null; f.prefs.community.paused = false;
  f.runtime.start(); await f.runtime.settled();
  assert.deepEqual(f.remote.order, ['community']); assert.equal(f.remote.comments.length, 1);
  assert.equal(f.remote.calls.find(c => c.path.endsWith('/comments') && c.body).headers['Idempotency-Key'], pending.key);
});

test('manager mention remains authorized if pause takes effect during generation', async t => {
  const f = fixture(t, { decision: { participate: true, body: '继续执行这次明确安排', reflection: '' } });
  f.remote.events = [{ id: '1', type: 'comment.mentioned', reply_to_actor_id: 'ai-test', author_id: 'human', post_id: 'post-test', resource_id: 'target-comment', manager_authorized: true }];
  f.remote.beforeDecision = () => { Object.assign(f.prefs.community, { paused: true, quiet_now: true, reply_to_interactions: false }); };
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.remote.comments.length, 1); assert.equal(f.remote.comments[0].parent_id, 'target-comment');
  assert.equal(f.runtime.state.pending, null);
});

test('paused activity refuses new post drafts without changing publication behavior', async t => {
  const f = fixture(t, { preferences: { paused: true } });
  f.runtime.start({ mode: 'publish_post', title: '新稿', body: '暂停时不自动交稿' }); await f.runtime.settled();
  assert.equal(f.runtime.publicStatus().error.code, 'community_paused');
  assert.equal(f.remote.draft, null); assert.equal(f.remote.calls.some(c => c.path === '/api/v1/agent/post-drafts'), false);
});

test('paused activity waits for human game acceptance despite saved auto-accept preference', async t => {
  const f = fixture(t, { game: true, accept: true, preferences: { paused: true } });
  f.runtime.start(); await f.runtime.settled();
  assert.equal(f.room.invitations[0].status, 'pending'); assert.deepEqual(f.remote.order, []);
  assert.equal(f.remote.calls.some(c => c.path.endsWith('/respond')), false);
  f.room.invitations[0].status = 'accepted';
  f.runtime.start(); await f.runtime.settled();
  assert.deepEqual(f.remote.order, ['game']); assert.equal(f.room.status, 'finished');
  assert.equal(f.remote.autoAccept, true, 'saved preference was not overwritten');
});

test('pause racing game invitation acceptance waits without stopping the companion', async t => {
  const f = fixture(t, { game: true, accept: true }); f.remote.pauseOnAccept = true;
  f.runtime.start({ mode: 'watch' }); f.runtime.pollInterval = 20;
  await until(() => f.runtime.preferences?.community?.paused === true);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.publicStatus().error, null);
  assert.deepEqual(f.remote.order, []); assert.equal(f.room.invitations[0].status, 'pending');
  f.runtime.stop(); await f.runtime.settled();
});

test('pause between automatic acceptance and ready waits for manager approval without losing the controller', async t => {
  const f = fixture(t, { game: true, accept: true }); f.remote.pauseOnReady = true;
  f.runtime.start({ mode: 'watch' }); f.runtime.pollInterval = 20;
  await until(() => f.runtime.preferences?.community?.paused === true);
  assert.equal(f.runtime.running(), true); assert.equal(f.runtime.publicStatus().error, null);
  assert.deepEqual(f.remote.order, []); assert.equal(f.gameRuntime.state.roomId, null);
  f.remote.pauseOnReady = false; f.remote.awaitManager = false;
  await until(() => f.room.status === 'finished');
  assert.deepEqual(f.remote.order, ['game']); assert.equal(f.remote.acquired, 1);
  f.runtime.stop(); await f.runtime.settled();
});
