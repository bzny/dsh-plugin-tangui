import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RuntimeApi } from '../lib/runtime-api.js';

const endpoint = '/api/v1/test-transport';

async function withServer(handler, run) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, endpoint);
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, requests: () => requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function expectedError(code, { transport = false, rejected = false, status } = {}) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.community_transport === true, transport);
    assert.equal(error.http_rejected === true, rejected);
    if (status !== undefined) assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /private-upstream-detail/);
    return true;
  };
}

test('real gateway HTML responses are transport errors with their HTTP status', async t => {
  for (const status of [502, 503, 504]) await t.test(`HTTP ${status}`, async () => {
    await withServer((request, response) => {
      response.writeHead(status, { 'content-type': 'text/html' });
      response.end('<html>private-upstream-detail</html>');
    }, async ({ baseUrl, requests }) => {
      const api = new RuntimeApi({ baseUrl });
      await assert.rejects(() => api.request(endpoint), expectedError('network_error', { transport: true, status }));
      assert.equal(requests(), 1);
    });
  });
});

test('actual socket destruction before headers is a transport failure', async () => {
  await withServer(request => request.socket.destroy(), async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl });
    await assert.rejects(() => api.request(endpoint), expectedError('network_error', { transport: true }));
    assert.equal(requests(), 1);
  });
});

test('gateway JSON without an explicit application error code is a transport failure', async () => {
  await withServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'private-upstream-detail' }));
  }, async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl });
    await assert.rejects(() => api.request(endpoint), expectedError('network_error', { transport: true, status: 503 }));
    assert.equal(requests(), 1);
  });
});

test('actual body interruption after JSON headers is a transport failure', async () => {
  let responseToInterrupt, receivedHeaders = false;
  await withServer((request, response) => {
    responseToInterrupt = response;
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    response.write('{"data":');
  }, async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl, fetchImpl: async (...args) => {
      const response = await fetch(...args);
      receivedHeaders = true;
      setImmediate(() => responseToInterrupt.destroy());
      return response;
    } });
    await assert.rejects(() => api.request(endpoint), expectedError('network_error', { transport: true }));
    assert.equal(receivedHeaders, true); assert.equal(requests(), 1);
  });
});

test('a stalled real response times out as transport failure before or after headers', async t => {
  for (const sendHeaders of [false, true]) await t.test(sendHeaders ? 'body timeout' : 'header timeout', async () => {
    await withServer((request, response) => {
      if (sendHeaders) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"data":');
      }
    }, async ({ baseUrl, requests }) => {
      const api = new RuntimeApi({ baseUrl, timeoutMs: 500 });
      await assert.rejects(() => api.request(endpoint), expectedError('network_error', { transport: true }));
      assert.equal(requests(), 1);
    });
  });
});

test('completed HTTP 200 malformed JSON is invalid_response without transport retry marker', async () => {
  await withServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('private-upstream-detail');
  }, async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl });
    await assert.rejects(() => api.request(endpoint), expectedError('invalid_response'));
    assert.equal(requests(), 1);
  });
});

test('HTTP error codes remain explicit application rejections including known and unknown 503 codes', async t => {
  for (const [status, code, expected = code] of [
    [401, 'unauthorized'], [409, 'control_lost'], [503, 'community_paused'], [503, 'future_server_code', 'community_request_failed'],
  ]) await t.test(code, async () => {
    await withServer((request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code, message: 'private-upstream-detail' } }));
    }, async ({ baseUrl, requests }) => {
      const api = new RuntimeApi({ baseUrl });
      await assert.rejects(() => api.request(endpoint), expectedError(expected, { rejected: true, status }));
      assert.equal(requests(), 1);
    });
  });
});

test('user abort stays run_stopped before or after response headers', async t => {
  for (const sendHeaders of [false, true]) await t.test(sendHeaders ? 'body abort' : 'header abort', async () => {
    const controller = new AbortController();
    await withServer((request, response) => {
      if (sendHeaders) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"data":');
      } else controller.abort();
    }, async ({ baseUrl, requests }) => {
      const api = new RuntimeApi({ baseUrl, fetchImpl: async (...args) => {
        const response = await fetch(...args);
        setImmediate(() => controller.abort());
        return response;
      } });
      await assert.rejects(() => api.request(endpoint, { signal: controller.signal }), expectedError('run_stopped'));
      assert.equal(requests(), 1);
    });
  });
});

test('Markdown body socket interruption also remains a transport failure', async () => {
  let responseToInterrupt;
  await withServer((request, response) => {
    responseToInterrupt = response;
    response.writeHead(200, { 'content-type': 'text/markdown', 'x-next-cursor': '', 'x-has-more': 'false', 'content-length': '1000' });
    response.write('# partial');
  }, async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl, fetchImpl: async (...args) => {
      const response = await fetch(...args);
      setImmediate(() => responseToInterrupt.destroy());
      return response;
    } });
    await assert.rejects(() => api.request(endpoint, { responseFormat: 'markdown' }), expectedError('network_error', { transport: true }));
    assert.equal(requests(), 1);
  });
});

test('Markdown body user cancellation remains run_stopped', async () => {
  const controller = new AbortController();
  await withServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/markdown', 'x-next-cursor': '', 'x-has-more': 'false' });
    response.write('# partial');
  }, async ({ baseUrl, requests }) => {
    const api = new RuntimeApi({ baseUrl, fetchImpl: async (...args) => {
      const response = await fetch(...args);
      setImmediate(() => controller.abort());
      return response;
    } });
    await assert.rejects(() => api.request(endpoint, { responseFormat: 'markdown', signal: controller.signal }), expectedError('run_stopped'));
    assert.equal(requests(), 1);
  });
});
