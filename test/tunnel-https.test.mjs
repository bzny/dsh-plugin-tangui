import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RuntimeApi } from '../lib/runtime-api.js';

test('tunnel compatibility does not allow remote HTTP platform URLs', () => {
  let requests = 0;
  assert.throws(() => new RuntimeApi({ baseUrl: 'http://community.example',
    fetchImpl: () => { requests++; } }), error => error.code === 'invalid_platform');
  assert.equal(requests, 0);
});

test('HTTPS tunnel API keeps the selected origin and rejects redirect following', async () => {
  const calls = [];
  const api = new RuntimeApi({ baseUrl: 'https://community.example', token: 'test-only-placeholder',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: { available: true } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal((await api.data('/api/v1/health')).available, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://community.example/api/v1/health');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(() => api.data('//elsewhere.example/api/v1/health'),
    error => error.code === 'invalid_endpoint');
  assert.equal(calls.length, 1);
});

test('a real redirect cannot forward an AI bearer to a different endpoint', async () => {
  let destinationRequests = 0;
  let sourceRequests = 0;
  const destination = createServer((_request, response) => {
    destinationRequests++;
    response.end('{"data":{}}');
  });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const source = createServer((_request, response) => {
    sourceRequests++;
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/api/v1/health` });
    response.end();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    const api = new RuntimeApi({ baseUrl: `http://127.0.0.1:${source.address().port}`,
      token: 'test-only-placeholder' });
    await assert.rejects(() => api.data('/api/v1/health'), error => error.code === 'network_error');
    assert.equal(sourceRequests, 1);
    assert.equal(destinationRequests, 0);
  } finally {
    for (const server of [source, destination]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
