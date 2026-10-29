import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MediaClient, readVideoContext, readPostVideos, MAX_CONTEXT_PAGES } from '../lib/media-client.js';
import { RuntimeApi, fail } from '../lib/runtime-api.js';
import { CommunityRuntime } from '../lib/runtime.js';
import { validateRuntimeInput } from '../lib/runtime-tool.js';
import { createRuntimeModel } from '../lib/runtime-model.js';

const page = (changes = {}) => ({ asset_id: 'media-test', state: 'ready', summary: '游戏演示', tags: ['游戏'], frame_interval_seconds: 3,
  segments: [{ start: 0, end: 2, text: '我们开始游戏', source: 'asr' }],
  frames: [{ index: 0, time: 0, description: '人物出现在棋盘上', url: 'PRIVATE_FRAME_URL' }], next_cursor: null, limitations: [], secret: 'PRIVATE_SECRET', ...changes });

const overview = (changes = {}) => ({ asset_id: 'media-test', state: 'ready', material_kind: 'overview', context_version: 2,
  summary: 'Q版角色跳舞，背景是绿幕。', content_type: '舞蹈', highlights: ['相似形象一起跳舞'], quotes: [], tags: ['二创'],
  limitations: ['静帧不能判断节拍。'], segments: [], frames: [], next_cursor: null,
  scope: { duration_seconds: 40, audio_track_present: true, transcript_state: 'no_speech_detected',
    speech_excerpted: false, sampled_frame_count: 14, sampled_times: ['PRIVATE_TIME'], private_path: 'PRIVATE_PATH' }, ...changes });

test('whole-video material needs one request, keeps audio distinction, and omits raw evidence', async () => {
  let calls = 0;
  const material = await readVideoContext(async () => {
    calls++;
    return overview({ segments: [{ text: 'PRIVATE_TRANSCRIPT' }], frames: [{ url: 'PRIVATE_URL' }], secret: 'PRIVATE_SECRET' });
  }, 'media-test');
  assert.equal(calls, 1); assert.equal(material.pages_read, 1);
  assert.equal(material.scope.audio_track_present, true);
  assert.equal(material.scope.transcript_state, 'no_speech_detected');
  assert.equal(material.summary, overview().summary);
  assert.match(material.notice, /不等于没有人声或音乐/);
  assert.ok(!JSON.stringify(material).includes('PRIVATE'));
  assert.equal(material.segments, undefined); assert.equal(material.frames, undefined);
});

test('invalid overview cannot silently become legacy or a completed reading', async () => {
  for (const change of [{ context_version: 3 }, { scope: null }, { summary: '  ' },
    { scope: { ...overview().scope, audio_track_present: 'false' } },
    { scope: { ...overview().scope, sampled_frame_count: 16 } },
    { scope: { ...overview().scope, transcript_state: 'no_sound' } },
    { scope: { ...overview().scope, duration_seconds: NaN } }]) {
    await assert.rejects(readVideoContext(async () => overview(change), 'media-test'), e => e.code === 'invalid_media_response');
  }
});

test('media client requests compact material', async () => {
  let route;
  const client = new MediaClient({ data: async value => { route = value; return overview(); } });
  await client.context('media-test');
  assert.equal(new URL(route, 'http://localhost').searchParams.get('view'), 'overview');
});

for (const failure of ['timeout', 'malformed_json']) {
  test(`overview reading ${failure} is counted once without publishing; explicit retry reuses server material`, async () => {
    let calls = 0, reads = 0, submissions = 0;
    const material = overview(), inputs = [];
    const decide = createRuntimeModel(() => ({
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      llm: { async prepareCall(config) {
        assert.equal(config.maxTokens, 64000);
        return { config, async *stream(request) {
          calls++;
          inputs.push(JSON.stringify(request.messages));
          if (calls === 1 && failure === 'timeout') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } };
            return;
          }
          const raw = calls === 1 ? '{broken JSON' : JSON.stringify({ participate: true, body: '两个Q版形象放在一起跳舞，像鱼塘里的双人节目。' });
          yield { type: 'text-delta', index: 0, text: raw };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: raw } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      } },
    }));
    const runtime = Object.create(CommunityRuntime.prototype);
    Object.assign(runtime, {
      state: { completed: [], model_calls: 0, cursor: '0', identity: { base_url: 'http://localhost' }, deferred_pending: [] },
      actor: { id: 'ai-test', kind: 'ai' }, abort: new AbortController(), decide,
      wallNow: () => Date.parse('2026-10-29T12:00:00Z'),
      checkActive() {}, budget() {}, phaseTo() {}, connectionReady: async () => {},
      commit(value) { Object.assign(this.state, value); }, diary: { record() {} },
      configuration: async () => ({ description: '伙伴', effective: {} }),
      get: async route => {
        if (route.includes('/context?')) {
          reads++; assert.match(route, /view=overview/); return { data: material };
        }
        if (route.includes('/comments?')) return { data: [], next_cursor: null };
        return { data: { id: 'post-test', title: '视频', author: { id: 'human-test' },
          content: [{ type: 'video', asset_id: 'media-test', context_state: 'ready' }] } };
      },
      async flushPending() {
        submissions++;
        assert.equal(this.state.pending.kind, 'comment');
        this.commit({ completed: this.completedFor('browse:post-test', 'post-test', null, true), pending: null });
      },
    });
    await assert.rejects(runtime.decideOn('post-test', 'browse:post-test'), e =>
      e.code === (failure === 'timeout' ? 'runtime_model_timeout' : 'invalid_model_decision'));
    assert.equal(calls, 1); assert.equal(runtime.state.model_calls, 1); assert.equal(submissions, 0);
    assert.deepEqual(runtime.state.completed, []); assert.equal(runtime.state.pending, undefined);
    assert.equal(await runtime.decideOn('post-test', 'browse:post-test'), true);
    assert.equal(calls, 2); assert.equal(runtime.state.model_calls, 2); assert.equal(submissions, 1);
    assert.equal(reads, 2); assert.ok(inputs.every(value => value.includes(material.summary) && !value.includes('PRIVATE')));
    assert.equal(await runtime.decideOn('post-test', 'browse:post-test'), false);
    assert.equal(calls, 2); assert.equal(submissions, 1);
  });
}

test('timestamped video material omits URLs/secrets and states sampling limits', async () => {
  const value = await readVideoContext(async () => page(), 'media-test');
  assert.equal(value.segments[0].start, 0); assert.equal(value.segments[0].source, 'asr');
  assert.equal(value.frames[0].time, 0); assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.match(value.notice, /不是完整视频/);
});

test('pagination and character clipping are bounded and explicitly disclosed', async () => {
  const calls = [];
  const value = await readVideoContext(async (_asset, cursor) => {
    calls.push(cursor);
    return page({ segments: [{ start: Number(cursor), end: Number(cursor)+1, text: 'A'.repeat(10000), source: 'asr' }], frames: [], next_cursor: String(Number(cursor)+1) });
  }, 'media-test');
  assert.equal(calls.length, MAX_CONTEXT_PAGES); assert.equal(value.truncated, true); assert.equal(value.next_cursor, '4');
  assert.match(value.limitations.at(-1), /不是该视频/); assert.ok(value.segments.every(item => item.text.length <= 4000));
});

test('mismatched asset, invalid timestamp and repeated cursor are rejected', async () => {
  for (const change of [{ asset_id: 'wrong' }, { next_cursor: '0' }, { frame_interval_seconds: 5 },
    { segments: [{ start: 5, end: 1, text: 'bad', source: 'asr' }] }, { segments: [{ start: NaN, end: 1, text: 'bad', source: 'asr' }] }]) {
    await assert.rejects(readVideoContext(async () => page(change), 'media-test'), error => error.code === 'invalid_media_response');
  }
});

test('ready post cannot override unready materials', async () => {
  await assert.rejects(readPostVideos(async () => page({ state: 'pending' }), {
    content: [{ type: 'video', asset_id: 'media-test', context_state: 'ready' }],
  }), error => error.code === 'media_context_pending');
});

test('actual runtime defers unready video without model budget or completion, then reads material', async () => {
  const runtime = Object.create(CommunityRuntime.prototype), inputs = [];
  let ready = false;
  Object.assign(runtime, {
    wallNow: () => Date.UTC(2026, 9, 29),
    state: { completed: [], model_calls: 0, cursor: '0', identity: {}, deferred_pending: [] },
    actor: { id: 'ai-test', kind: 'ai' }, abort: new AbortController(),
    checkActive() {}, budget() {}, phaseTo() {}, commit(value) { Object.assign(this.state, value); },
    diary: { record() {} }, configuration: async () => ({ description: '伙伴', effective: {} }),
    decide: async context => { inputs.push(context); return { participate: false, body: '' }; },
    get: async path => {
      if (path.includes('/context?')) return { data: page() };
      if (path.includes('/comments?')) return { data: [], next_cursor: null };
      return { data: { id: 'post-test', title: '测试视频', body: '来看看', author: { id: 'human-test' },
        content: [{ type: 'video', asset_id: 'media-test', context_state: ready ? 'ready' : 'pending' }] } };
    },
  });
  assert.equal(await runtime.decideOn('post-test', 'browse:post-test'), false);
  assert.equal(runtime.state.model_calls, 0); assert.deepEqual(runtime.state.completed, []);
  ready = true;
  assert.equal(await runtime.decideOn('post-test', 'browse:post-test'), true);
  assert.equal(inputs.length, 1); assert.ok(inputs[0].post.video_material[0].frames[0].description);
});

async function uploadFixture(t) {
  const root = resolve('.test-work'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'media-client-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(root)); await rm(directory, { recursive: true }); });
  const path = join(directory, 'chosen.mp4'); await writeFile(path, '0123456789');
  const remote = { bytes: Buffer.alloc(0), calls: [], lost: true, reject: false };
  const status = () => ({ upload_id: 'upload-test', asset_id: 'media-test', received_bytes: remote.bytes.length, chunk_bytes: 3 });
  const api = { data: async route => {
    remote.calls.push(['GET', route]);
    return route === '/api/v1/media/policy' ? { max_upload_bytes: 1024 } : status();
  } };
  const write = async (route, body, key, method = 'POST') => {
    remote.calls.push([method, route, body, key]);
    if (route.endsWith('/complete')) return { id: 'media-test', state: 'processing' };
    if (method === 'PUT') {
      assert.equal(Number(route.split('offset=')[1]), remote.bytes.length);
      if (remote.reject) { remote.reject = false; throw fail('network_error', 'fake'); }
      remote.bytes = Buffer.concat([remote.bytes, body]);
      if (remote.lost) { remote.lost = false; throw fail('network_error', 'fake'); }
    }
    return status();
  };
  return { path, remote, client: new MediaClient(api, { write }) };
}

test('lost chunk response checks offset and never duplicates bytes', async t => {
  const { path, remote, client } = await uploadFixture(t), checkpoints = [];
  const result = await client.uploadFile(path, 'stable-request', { checkpoint: value => checkpoints.push(value) });
  assert.equal(result.state, 'processing'); assert.equal(remote.bytes.toString(), '0123456789');
  assert.deepEqual(remote.calls.filter(call => call[0] === 'PUT').map(call => call[1].split('offset=')[1]), ['0', '3', '6', '9']);
  assert.equal(checkpoints.at(-1).received_bytes, 10); assert.ok(!JSON.stringify(remote.calls).includes(path));
});

for (const stage of ['create', 'offset_recovery']) {
  test(`malformed ${stage} upload response preserves controlled error`, async t => {
    const { path, remote, client } = await uploadFixture(t);
    const write = client.write, read = client.api.data;
    client.write = (route, ...args) => stage === 'create' && route === '/api/v1/media/uploads' ? null : write(route, ...args);
    client.api.data = route => stage === 'offset_recovery' && route === '/api/v1/media/uploads/upload-test' ? null : read(route);
    await assert.rejects(client.uploadFile(path, 'stable-request'), error => error.code === 'invalid_media_response');
    assert.ok(remote.calls.filter(call => call[0] === 'PUT').length <= 1);
  });
}

test('unaccepted chunk returns to caller; restart resumes same upload; changed file is refused', async t => {
  const { path, remote, client } = await uploadFixture(t), checkpoints = [];
  remote.reject = true;
  await assert.rejects(client.uploadFile(path, 'stable-request', { checkpoint: value => checkpoints.push(value) }), error => error.code === 'network_error');
  assert.equal(remote.bytes.length, 0);
  await client.uploadFile(path, 'stable-request', { resume: checkpoints.at(-1), checkpoint: value => checkpoints.push(value) });
  assert.equal(remote.bytes.toString(), '0123456789');
  assert.equal(remote.calls.filter(call => call[0] === 'POST' && call[1] === '/api/v1/media/uploads').length, 1);
  await writeFile(path, 'DIFFERENT!');
  await assert.rejects(client.uploadFile(path, 'stable-request', { resume: checkpoints.at(-1) }), error => error.code === 'media_upload_source_changed');
});

test('binary transport is limited to bounded video upload route and keeps control proof', async () => {
  let sent;
  const api = new RuntimeApi({ baseUrl: 'http://127.0.0.1:4999', token: 'FAKE_TEST_TOKEN', fetchImpl: async (_url, request) => {
    sent = request; return { ok: true, status: 200, json: async () => ({ data: { received_bytes: 3 } }) };
  } });
  await api.data('/api/v1/media/uploads/upload-test?offset=0', { method: 'PUT', body: Buffer.from('123'), headers: { 'X-AI-Control-Epoch': '8' } });
  assert.equal(sent.method, 'PUT'); assert.equal(sent.headers['content-type'], 'application/octet-stream');
  assert.equal(sent.headers['X-AI-Control-Epoch'], '8'); assert.equal(sent.redirect, 'error'); assert.equal(sent.body.toString(), '123');
  await assert.rejects(api.data('/api/v1/posts', { method: 'PUT', body: Buffer.from('123') }), error => error.code === 'invalid_endpoint');
  assert.throws(() => new MediaClient(api).prepare('example.mp4', 'request-id'), error => error.code === 'control_required');
});

test('video_context tool accepts only asset reference, no path or credential', () => {
  validateRuntimeInput({ action: 'video_context', asset_id: 'media-test' });
  assert.throws(() => validateRuntimeInput({ action: 'video_context', path: 'C:/private.mp4' }), error => error.code === 'invalid_argument');
});
