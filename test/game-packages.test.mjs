// Client-only contract checks for a previously unknown installed game.
// Controlled fetch/model fixtures; platform package install is tested in Python.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GameRuntime, GAME_PROTOCOL } from '../lib/game-runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const RULES = 'take-stones/1.0';
const ACTOR = { id: 'package-fixture-ai', kind: 'ai', name: '包接口测试伙伴' };
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(t, { variant = false, listed = true, mismatch = null } = {}) {
  const directory = join(ROOT, `game-package-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const now = 1_800_000_000_000, calls = [], modelCalls = [];
  const rules = variant ? RULES + '-short' : RULES;
  const manifest = { protocol: GAME_PROTOCOL, id: 'take-stones', version: '1.0',
    rules_version: RULES, listed, ...(variant ? { rules_versions: [rules] } : {}) };
  if (mismatch) manifest[mismatch.field] = mismatch.value;
  const room = { id: 'package-room', game_id: 'take-stones', game_version: '1.0', rules_version: rules,
    status: 'waiting', seats: [], invitations: [{ id: 'package-invite', actor_id: ACTOR.id, status: 'accepted' }] };
  const snapshot = { protocol: GAME_PROTOCOL, room, server_time: new Date(now).toISOString(), seq: 0,
    rules: { id: rules, text: '每次取1至3颗，取完最后一颗获胜。' },
    observation: { remaining: 21, turn_seat_id: 0, players: [{ id: ACTOR.id, taken: 0 }] },
    action_request: null, result: null };
  const owner = { actor: ACTOR, instanceId: 'package-controller', abort: new AbortController(),
    lease: { epoch: 1, deadline: 60000, renewAt: 15000 }, checkActive() {},
    proof: () => ({ 'X-AI-Instance-ID': 'package-controller', 'X-AI-Control-Epoch': '1' }),
    configuration: async () => ({ description: '仔细观察，按规则游戏。', effective: {} }) };
  const runtime = new GameRuntime({ bridge: { state: { instanceId: owner.instanceId } },
    stateFile: join(directory, 'state.json'), automatic: false, now: () => now, monotonic: () => 10000,
    decide: async (context, options) => {
      modelCalls.push({ context: clone(context), deadline: options.deadline });
      return { action_id: context.action_request.legal_actions.at(-1).action_id, commentary: '先取三颗。' };
    },
    fetchImpl: async (address, options) => {
      const url = new URL(address), body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: url.pathname, version: url.searchParams.get('version'), body });
      assert.equal(options.headers.authorization, 'Bearer FIXTURE_ONLY_PACKAGE_TOKEN');
      let data;
      switch (url.pathname) {
        case '/api/v1/agent/game-assignment': data = { room }; break;
        case '/api/v1/game-rooms/package-room/state': data = snapshot; break;
        case '/api/v1/games/take-stones/manifest':
          assert.equal(url.searchParams.get('version'), '1.0'); data = manifest; break;
        case '/api/v1/game-rooms/package-room/ready':
          assert.deepEqual(body, { game_version: '1.0', rules_version: rules });
          room.seats = [{ seat_id: 0, actor_id: ACTOR.id, kind: 'ai' }]; data = room; break;
        case '/api/v1/game-rooms/package-room/actions':
          assert.equal(options.headers['X-AI-Instance-ID'], owner.instanceId);
          assert.equal(options.headers['X-AI-Control-Epoch'], '1');
          assert.ok(options.headers['Idempotency-Key']);
          assert.equal(body.based_on_revision, 0);
          assert.deepEqual(body.decision, { action_id: 'take-3' });
          data = { status: 'accepted', request_id: body.request_id }; break;
        default: assert.fail(`Unexpected fixture request: ${url.pathname}`);
      }
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  await runtime.attachSession(owner, { baseUrl: 'http://127.0.0.1:4999', actorId: ACTOR.id,
    token: 'FIXTURE_ONLY_PACKAGE_TOKEN', grantId: 'package-fixture-grant' });
  runtime.state.maxModelCalls = 5;
  t.after(async () => {
    await runtime.stop();
    const child = relative(ROOT, resolve(directory));
    assert.ok(child && !child.startsWith('..') && !child.includes(':'));
    rmSync(directory, { recursive: true });
  });
  return { runtime, room, snapshot, modelCalls, calls,
    openTurn() {
      room.status = 'playing';
      const actions = [1, 2, 3].map(count => ({ action_id: `take-${count}`, type: 'take', count }));
      snapshot.action_request = { request_id: 'take-stones-turn-1', based_on_revision: 0,
        deadline_at: new Date(now + 35000).toISOString(), legal_actions: actions, default_action: actions[0] };
    } };
}

for (const options of [{ variant: false, listed: true }, { variant: true, listed: true }, { variant: false, listed: false }]) {
  test(`unknown package readies and plays through generic client ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    await f.runtime.step();
    assert.equal(f.calls.filter(call => call.path.endsWith('/ready')).length, 1);
    assert.equal(f.modelCalls.length, 0);
    f.openTurn();
    await f.runtime.step();
    await f.runtime.active.promise;
    await f.runtime.step();
    await f.runtime.step();
    assert.equal(f.modelCalls.length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/actions')).length, 1);
    const { context, deadline } = f.modelCalls[0];
    assert.deepEqual(context.rules, f.snapshot.rules);
    assert.deepEqual(context.observation, f.snapshot.observation);
    assert.equal(context.action_request.default_action.count, 1);
    assert.equal(context.action_request.legal_actions.at(-1).type, 'take');
    assert.equal(deadline, 45000);
    assert.equal(f.runtime.status().modelCalls, 1);
  });
}

for (const mismatch of [{ field: 'version', value: '2.0' }, { field: 'rules_version', value: 'unknown-rules' }]) {
  test(`unknown package rejects mismatched ${mismatch.field} before ready/model`, async t => {
    const f = await fixture(t, { mismatch });
    await f.runtime.step();
    assert.equal(f.runtime.status().status, 'unsupported_game_version');
    assert.equal(f.modelCalls.length, 0);
    assert.equal(f.calls.filter(call => /\/(ready|actions)$/.test(call.path)).length, 0);
  });
}
