/** Real A1 HTTP smoke driver. Credentials arrive only on stdin; no real model is called. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { GameRuntime, GAME_PROTOCOL } from '../lib/game-runtime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let runtime, input, roomId, stage = 'input', ready = false, acceptedActions = 0, modelCalls = 0;
let protocol = null;

function fail(code) {
  const error = new Error(code);
  error.smokeCode = code;
  throw error;
}

async function humanRequest(path, body) {
  assert.ok(path.startsWith('/api/v1/'));
  const response = await fetch(input.baseUrl + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(input.humanCookie ? { Cookie: input.humanCookie } : { authorization: `Bearer ${input.humanToken}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'Idempotency-Key': randomUUID(), Origin: input.baseUrl }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (!response.ok) {
    const code = payload?.error?.code;
    fail(typeof code === 'string' && /^[a-z][a-z0-9_]{0,70}$/.test(code) ? code : 'http_request_failed');
  }
  if (!Object.hasOwn(payload, 'data')) fail('missing_response_data');
  return payload.data;
}

function checkRunning() {
  const status = runtime.status();
  if (!status.running) fail(status.error || status.status || 'runtime_stopped');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  input = JSON.parse(raw);
  const origin = new URL(input.baseUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.search || origin.hash || !origin.port) fail('isolated_loopback_required');
  input.baseUrl = origin.origin;
  if (typeof input.actorId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.actorId)
      || !((typeof input.humanCookie === 'string' && input.humanCookie)
           || (typeof input.humanToken === 'string' && input.humanToken))
      || typeof input.stateFile !== 'string' || !isAbsolute(input.stateFile)
      || existsSync(input.stateFile)) fail('fresh_isolated_input_required');
  if (input.roomId && (typeof input.roomId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.roomId))) fail('invalid_room_id');

  const bridge = { busy: false, state: { baseUrl: input.baseUrl, instanceId: randomUUID(),
    binding: { actorId: input.actorId, grantId: 'isolated-registration-placeholder' } } };
  runtime = new GameRuntime({ bridge, stateFile: input.stateFile, automatic: false,
    decide: async (snapshot) => {
      modelCalls++;
      assert.equal(snapshot.protocol, GAME_PROTOCOL);
      protocol = snapshot.protocol;
      const request = snapshot.action_request;
      assert.ok(request);
      const actionId = request.default_action?.action_id;
      assert.ok(request.legal_actions.some((action) => action.action_id === actionId));
      return { action_id: actionId, commentary: '隔离接入验证：选择本次合法默认动作。' };
    },
  });

  stage = 'pairing';
  const started = await runtime.start({ maxModelCalls: 5, ...(input.roomId ? { roomId: input.roomId } : {}) });
  assert.equal(started.status, 'awaiting_approval');
  assert.ok(started.pairing?.userCode);
  await humanRequest('/api/v1/pairings/approve', {
    user_code: started.pairing.userCode, actor_id: input.actorId, scopes: ['games:play'],
  });
  await sleep(5100);
  await runtime.step();
  checkRunning();
  assert.equal(runtime.status().binding?.actorId, input.actorId);
  assert.equal(modelCalls, 0);

  stage = 'room_invitation';
  if (input.roomId) {
    roomId = input.roomId;
    const snapshot = await humanRequest(`/api/v1/game-rooms/${roomId}/state`);
    assert.equal(snapshot.room.status, 'waiting');
    assert.equal(snapshot.room.seats.length, 0);
  } else {
    const room = await humanRequest('/api/v1/game-rooms', {
      game_id: 'mahjong', name: 'DSH真实HTTP隔离验证',
      settings: { match_mode: 'east', replay_visibility: 'participants' },
    });
    roomId = room.id;
  }
  const invited = await humanRequest(`/api/v1/game-rooms/${roomId}/join`, { actor_id: input.actorId });
  const invitation = invited.invitations.find((entry) => entry.actor_id === input.actorId);
  assert.ok(invitation);
  assert.equal(invitation.status, 'pending');
  // This is an explicit manager acceptance in the test; the runtime never accepts invitations.
  await humanRequest(`/api/v1/game-invitations/${invitation.id}/respond`, { accept: true });

  stage = 'ready';
  for (let attempt = 0; attempt < 10; attempt++) {
    await runtime.step();
    checkRunning();
    const snapshot = await humanRequest(`/api/v1/game-rooms/${roomId}/state`);
    const seat = snapshot.room.seats.find((entry) => entry.actor_id === input.actorId);
    if (seat?.ready) { ready = true; break; }
    await sleep(100);
  }
  assert.equal(ready, true);
  assert.equal(modelCalls, 0);
  const filled = await humanRequest(`/api/v1/game-rooms/${roomId}/join`, { fill_empty_seats: true });
  assert.equal(filled.seats.length, 4);
  assert.equal(filled.seats.filter((seat) => seat.kind === 'bot').length, 3);
  assert.equal(filled.seats.filter((seat) => seat.kind === 'human').length, 0);
  await humanRequest(`/api/v1/game-rooms/${roomId}/start`, {});

  stage = 'action';
  const stopAt = Date.now() + 45000;
  while (Date.now() < stopAt) {
    await runtime.step();
    const journal = runtime.state.journals[roomId];
    acceptedActions = Object.values(journal?.requests || {}).filter((record) => record.status === 'accepted').length;
    if (acceptedActions > 0) break;
    checkRunning();
    await sleep(100);
  }
  assert.ok(acceptedActions >= 1);
  assert.equal(runtime.state.journals[roomId].modelCalls, modelCalls);
  assert.equal(protocol, GAME_PROTOCOL);

  stage = 'release';
  await runtime.stop();
  const control = await humanRequest(`/api/v1/manage/actors/${input.actorId}/control`);
  assert.equal(control.active, false);
  assert.equal(runtime.status().running, false);
  return { passed: true, roomId, actorId: input.actorId, acceptedActions, modelCalls, ready, protocol };
}

try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  try { await runtime?.stop(); } catch { /* Never print raw transport errors or credentials. */ }
  const candidate = error.smokeCode || error.code || 'smoke_failed';
  const code = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,70}$/.test(candidate) ? candidate : 'smoke_failed';
  process.stderr.write(JSON.stringify({ passed: false, stage, code }) + '\n');
  process.exitCode = 1;
}
