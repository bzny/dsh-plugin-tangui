import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistrationBridge } from '../lib/core.js';
import { RuntimeConnection } from '../lib/runtime-connection.js';
import { CommunityRuntime } from '../lib/runtime.js';
import { GameRuntime } from '../lib/game-runtime.js';
import { atomicState } from '../lib/runtime-api.js';
import { DEFAULT_COMMUNITY_ORIGIN as NEW, PREVIOUS_COMMUNITY_ORIGIN as OLD, sameCommunityOrigin, currentCommunityLink, communityStoragePath } from '../lib/community-origin.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const binding = (origin = OLD, actorId = 'fixture-ai') => ({ baseUrl: origin, actorId, actorName: '测试伙伴',
  grantId: 'fixture-grant', token: 'FIXTURE_ONLY_TOKEN', revision: 4, scopes: ['posts:read', 'comments:write', 'events:read', 'games:play'] });
function directory(t) {
  const dir = join(ROOT, `origin-${randomUUID()}`); mkdirSync(dir, { recursive: true });
  t.after(() => { assert.ok(resolve(dir).startsWith(ROOT + '\\') || resolve(dir).startsWith(ROOT + '/')); rmSync(dir, { recursive: true }); });
  return dir;
}
function saveBridge(file, b, extra = {}) {
  const { baseUrl, ...credential } = b;
  const state = { version: 1, enabled: false, baseUrl, binding: credential, memoryDir: '', status: 'connected', ...extra };
  atomicState(file, state); return state;
}

test('official migration keeps identity, permissions, persona and exact uncertain request without network or model calls', t => {
  const file = join(directory(t), 'state.json');
  const pending = { stage: 'attempted', key: 'fixture-exact-request', body: { description: 'unchanged private fixture' } };
  const original = saveBridge(file, binding(), { pending, draft: { name: '伙伴', description: 'persona', overrides: {} } });
  const bytes = readFileSync(file, 'utf8');
  const bridge = new RegistrationBridge({ stateFile: file, fetchImpl: () => assert.fail('Migration cannot call network'),
    normalizePersona: () => assert.fail('Migration cannot call a model') });
  assert.equal(bridge.state.baseUrl, NEW);
  assert.deepEqual(bridge.state.binding, { ...original.binding, storageBaseUrl: OLD });
  assert.deepEqual(bridge.state.pending, pending);
  assert.deepEqual(bridge.state.draft, original.draft);
  assert.equal(bridge.state.enabled, false);
  assert.equal(readFileSync(`${file}.before-a2-origin`, 'utf8'), bytes);
  const again = new RegistrationBridge({ stateFile: file });
  assert.equal(again.state.baseUrl, NEW); assert.equal(again.state.binding.storageBaseUrl, OLD);
  assert.equal(readFileSync(`${file}.before-a2-origin`, 'utf8'), bytes);
});

test('runtime grant and pending pairing migrate together without widening or redeeming credentials', t => {
  const dir = directory(t), file = join(dir, 'runtime-connection.json'), primary = join(dir, 'state.json');
  saveBridge(primary, binding()); const bridge = new RegistrationBridge({ stateFile: primary });
  const pair = { baseUrl: OLD, actorId: 'fixture-ai', deviceCode: 'FIXTURE_DEVICE', userCode: 'FIXTURE_CODE', expiresAt: 100, nextPoll: 10, posts: false, redeeming: true };
  atomicState(file, { version: 1, binding: binding(), pair });
  const connection = new RuntimeConnection({ stateFile: file, bridge, fetchImpl: () => assert.fail('No token redemption') });
  assert.deepEqual(connection.binding(), { ...binding(NEW), storageBaseUrl: OLD });
  assert.equal(connection.state.pair.baseUrl, NEW);
  assert.equal(connection.state.pair.deviceCode, pair.deviceCode);
  assert.equal(connection.state.pair.uncertain, true);
  assert.equal(connection.error.code, 'authorization_result_unknown');
});

test('new installs use new entry; local, custom and lookalike domains retain exact endpoints', t => {
  const dir = directory(t);
  assert.equal(new RegistrationBridge({ stateFile: join(dir, 'fresh.json') }).state.baseUrl, NEW);
  for (const [index, origin] of ['http://127.0.0.1:4180', 'https://custom.example', 'https://test.csiparty.cn.example'].entries()) {
    const file = join(dir, `${index}.json`); saveBridge(file, binding(origin));
    const before = readFileSync(file, 'utf8'), bridge = new RegistrationBridge({ stateFile: file });
    assert.equal(bridge.state.baseUrl, origin); assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(`${file}.before-a2-origin`), false);
  }
  assert.equal(sameCommunityOrigin(OLD, NEW), true);
  assert.equal(sameCommunityOrigin('https://test.csiparty.cn.example', NEW), false);
  assert.equal(currentCommunityLink(`${OLD}/messages?draft=fixture#post-drafts`), `${NEW}/messages?draft=fixture#post-drafts`);
  assert.equal(currentCommunityLink('https://custom.example/path'), 'https://custom.example/path');
});

test('a bound state with a missing origin is preserved and rejected rather than sending its token to the default', t => {
  const file = join(directory(t), 'missing-origin.json'); saveBridge(file, binding(''));
  const original = readFileSync(file, 'utf8');
  assert.throws(() => new RegistrationBridge({ stateFile: file }), { code: 'state_invalid' });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(`${file}.before-a2-origin`), false);
});

test('manual new-origin progress is reused if there is no legacy record; when both exist no history is guessed or overwritten', t => {
  const dir = directory(t), actorId = 'fixture-ai';
  const current = communityStoragePath(dir, NEW, actorId, { suffix: '.json' });
  atomicState(current, { fixture: 'current' });
  assert.equal(communityStoragePath(dir, NEW, actorId, { storageBaseUrl: OLD, suffix: '.json' }), current);
  const previous = communityStoragePath(dir, OLD, actorId, { suffix: '.json' });
  atomicState(previous, { fixture: 'previous' });
  assert.equal(communityStoragePath(dir, NEW, actorId, { suffix: '.json' }), current);
  assert.equal(communityStoragePath(dir, NEW, actorId, { storageBaseUrl: OLD, suffix: '.json' }), previous);
  assert.deepEqual(JSON.parse(readFileSync(current, 'utf8')), { fixture: 'current' });
  assert.deepEqual(JSON.parse(readFileSync(previous, 'utf8')), { fixture: 'previous' });
});

test('migrated runtime reuses reading progress, budgets, uncertain reply and local diary instead of creating a new profile', t => {
  const dir = directory(t), stateFile = join(dir, 'state.json'), runtimeDir = join(dir, 'runtime');
  const originalBinding = binding();
  const original = new CommunityRuntime({ directory: runtimeDir, connection: { binding: () => originalBinding } });
  const pending = { kind: 'comment', key: 'fixture-reply-key', action: 'reply', post_id: 'post-fixture', payload: { body: 'already generated' } };
  original.commit({ model_calls: 9, replies: 3, posts: 1, cursor: '42', discovery_cursor: '50', completed: ['browse:post-fixture'], pending, diary_timezone: 'Asia/Shanghai' });
  original.diary.record({ id: 'thought-fixture', occurred_at: '2026-10-31T01:00:00Z', kind: 'post_read', reaction: null, reflection: 'already thought', resource: {} });
  const oldPath = original.stateFile, oldDiary = original.diary.directory;
  saveBridge(stateFile, originalBinding);
  const bridge = new RegistrationBridge({ stateFile });
  const connection = new RuntimeConnection({ stateFile: `${stateFile}.runtime-connection.json`, bridge });
  const runtime = new CommunityRuntime({ directory: runtimeDir, connection });
  assert.equal(runtime.stateFile, oldPath); assert.equal(runtime.diary.directory, oldDiary);
  assert.equal(runtime.state.identity.base_url, NEW); assert.equal(runtime.state.model_calls, 9);
  assert.equal(runtime.state.cursor, '42'); assert.deepEqual(runtime.state.pending, pending);
  assert.equal([...runtime.diary.entries()].length, 1); assert.equal(runtime.running(), false);
  runtime.commit({ cursor: '43' });
  const restarted = new CommunityRuntime({ directory: runtimeDir, connection });
  assert.equal(restarted.state.cursor, '43'); assert.equal(restarted.state.model_calls, 9);
  assert.deepEqual(restarted.state.pending, pending);
  const saved = { version: 1, identity: { baseUrl: OLD, actorId: 'fixture-ai', grantId: 'fixture-grant' }, options: { mode: 'watch' }, game: null };
  runtime.start = options => options;
  assert.deepEqual(runtime.resumeAfterUpdate(saved), saved.options);
  assert.throws(() => runtime.resumeAfterUpdate({ ...saved, identity: { ...saved.identity, actorId: 'other-ai' } }), { code: 'update_resume_identity_changed' });
});

test('same AI on the new official entry keeps game journals including unresolved action receipts', async t => {
  const file = join(directory(t), 'games.json');
  const journal = { modelCalls: 5, requests: { turn: { status: 'pending', submittedOnce: true, key: 'fixture-game-key', action: { action_id: 'pass' } } } };
  atomicState(file, { version: 1, identity: { baseUrl: OLD, actorId: 'fixture-ai' }, journals: { room: journal }, binding: null });
  const game = new GameRuntime({ stateFile: file, bridge: {}, automatic: false, decide: () => assert.fail('No game model during migration') });
  const owner = { abort: new AbortController(), lease: {}, actor: { id: 'fixture-ai' }, configuration: async () => ({}) };
  await game.attachSession(owner, binding(NEW));
  assert.deepEqual(game.state.journals.room, journal); assert.equal(game.state.identity.baseUrl, NEW);
  assert.equal(game.busy, true); await game.stop();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).identity.baseUrl, NEW);
});

test('different AI and unrelated community select separate game profiles; switching back restores the original without mixing', t => {
  const file = join(directory(t), 'games.json');
  const first = { baseUrl: OLD, actorId: 'first-ai' }, second = { baseUrl: NEW, actorId: 'second-ai' };
  const original = { version: 1, identity: first, binding: { token: 'FIXTURE_OLD_GAME', actorId: 'first-ai' }, pairing: null, journals: { oldRoom: { modelCalls: 8, requests: {} } }, status: 'stopped', enabled: false };
  atomicState(file, original);
  const game = new GameRuntime({ stateFile: file, bridge: {}, automatic: false });
  game.selectIdentity(second);
  assert.deepEqual(game.state.journals, {}); assert.equal(game.state.binding, null);
  assert.deepEqual(JSON.parse(readFileSync(game.profilePath(first), 'utf8')).journals, original.journals);
  game.state.journals.newRoom = { modelCalls: 2, requests: {} }; game.save();
  game.selectIdentity({ ...first, baseUrl: NEW });
  assert.deepEqual(game.state.journals, original.journals);
  assert.equal(game.state.binding.token, 'FIXTURE_OLD_GAME');
  game.selectIdentity({ baseUrl: 'https://unrelated.example', actorId: 'first-ai' });
  assert.deepEqual(game.state.journals, {}); assert.equal(game.state.binding, null);
  game.busy = true;
  assert.throws(() => game.selectIdentity(second), { code: 'control_busy' });
});
