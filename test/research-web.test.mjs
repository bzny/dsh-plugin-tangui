import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchWeb, researchPublicUrl } from '../lib/research-web.js';

const result = sources => ({ sources, truncated: false });
const source = (url, extra = {}) => ({ url, title: '公开研究资料', snippet: '搜索提供的摘要', publishedAt: '2026-11-04', ...extra });
const page = (url, content = '这是实际读取的网页内容。') => ({ url, statusCode: 200, body: { kind: 'text', content }, truncated: false });

test('public URLs exclude local addresses, credential queries and fragments before any provider access', () => {
  for (const url of ['http://example.com/', 'https://localhost/', 'https://host.local./', 'https://10.0.0.1/',
    'https://127.1/', 'https://2130706433/', 'https://[::1]/', 'https://host.internal/', 'https://metadata.google.internal/',
    'https://u:p@example.com/', 'https://example.com:8443/', 'https://example.com/?api_key=abc',
    'https://example.com/?%74oken=abc', 'https://example.com/\nsecret', 'https://example.com\\secret']) assert.equal(researchPublicUrl(url), null, url);
  assert.equal(researchPublicUrl('https://EXAMPLE.com/article#section'), 'https://example.com/article');
});

test('search matches DSH host request/result contract; bounded fields never forward provider answer or extras', async () => {
  const calls = [];
  const run = createResearchWeb(() => ({ async search(request, signal) {
    calls.push(request); assert.equal(signal instanceof AbortSignal, true);
    return { ...result([source('https://example.com/a#one', { title: 'x'.repeat(250), snippet: 's'.repeat(1700), hidden: 'private-extra' }),
      source('https://example.com/a#two'), source('https://127.0.0.1/admin')]), content: 'untrusted generated provider answer' };
  } }));
  const output = await run({ queries: ['麻将决策', ' 麻将决策 '] });
  assert.deepEqual(calls, [{ query: '麻将决策', maxResults: 10 }]);
  assert.deepEqual(output.counts, { queries: 1, pages: 1, read: 0, read_attempts: 0 });
  assert.deepEqual(Object.keys(output.sources[0]), ['url', 'title', 'snippet', 'date', 'read_status']);
  assert.equal(output.sources[0].title.length, 200); assert.equal(output.sources[0].snippet.length, 1500);
  assert.equal(output.sources[0].read_status, 'search_excerpt');
  assert.doesNotMatch(JSON.stringify(output), /private-extra|provider answer/);
});

test('three over-returning queries still supply no more than thirty distinct sources', async () => {
  let calls = 0;
  const run = createResearchWeb(() => ({ async search() { const n = calls++; return result(Array.from({ length: 100 }, (_, i) => source(`https://site${n}.com/${i}`))); } }));
  const output = await run({ queries: ['a', 'b', 'c'] });
  assert.equal(calls, 3); assert.equal(output.sources.length, 30); assert.equal(output.counts.pages, 30);
  await assert.rejects(run({ queries: ['a', 'b', 'c', 'd'] }), { code: 'research_invalid_input' });
  assert.equal(calls, 3);
});

test('an empty research plan does not access search or fetch and private queries fail before access', async () => {
  let calls = 0;
  const run = createResearchWeb(() => ({ search() { calls++; }, fetch() { calls++; } }));
  assert.deepEqual((await run({ queries: [] })).counts, { queries: 0, pages: 0, read: 0, read_attempts: 0 });
  for (const queries of [['api_key=sk_abcdefghijklmno'], ['contact somebody@example.com'], [''], ['x'.repeat(241)]]) {
    await assert.rejects(run({ queries }), { code: 'research_invalid_input' });
  }
  assert.equal(calls, 0);
});

test('reads at most six distinct domains using the real host fetch response shape', async () => {
  const reads = [];
  const run = createResearchWeb(() => ({
    async search() { return result(Array.from({ length: 10 }, (_, i) => source(`https://site${Math.floor(i / 2)}.com/${i}`))); },
    async fetch(request, signal) { reads.push(request.url); assert.equal(signal instanceof AbortSignal, true); return page(request.url); },
  }));
  const output = await run({ queries: ['研究'], read_limit: 6 });
  assert.equal(reads.length, 5); assert.equal(output.counts.read, 5);
  assert.equal(output.sources.filter(s => s.read_status === 'search_excerpt').length, 5);
  assert.equal(output.sources.filter(s => s.read_status === 'page_excerpt').length, 5);
  assert.deepEqual(reads, [0, 2, 4, 6, 8].map(i => `https://site${i / 2}.com/${i}`));
});

test('explicit reads cannot fetch URLs absent from this round and retries are not invented', async () => {
  const reads = [];
  const run = createResearchWeb(() => ({ async search() { return result([source('https://example.com/a')]); },
    async fetch({ url }) { reads.push(url); return page(url); } }));
  await assert.rejects(run({ queries: ['研究'], read_urls: ['https://example.com/unknown'] }), { code: 'research_invalid_input' });
  assert.equal(reads.length, 0);
  const output = await run({ queries: ['研究'], read_urls: ['https://example.com/a#one', 'https://example.com/a#two'] });
  assert.equal(reads.length, 1); assert.equal(output.counts.read, 1);
});

test('HTML remains inert, text is bounded and missing reader never claims a page was read', async () => {
  const run = createResearchWeb(() => ({ async search() { return result([source('https://example.com/a')]); },
    async fetch({ url }) { return { ...page(url), body: { kind: 'html', content: '<script>PRIVATE_SCRIPT()</script><style>PRIVATE_STYLE</style><p>A &amp; B &#20013;</p>' + '<p>content</p>'.repeat(2000) } }; } }));
  const output = await run({ queries: ['研究'], read_limit: 1 });
  assert.equal(output.sources[0].text.length, 8000); assert.equal(output.sources[0].truncated, true);
  assert.match(output.sources[0].text, /A & B 中/); assert.doesNotMatch(output.sources[0].text, /PRIVATE_|<script>/);
  const unavailable = await createResearchWeb(() => ({ async search() { return result([source('https://example.com/a')]); } }))({ queries: ['研究'], read_limit: 1 });
  assert.equal(unavailable.sources[0].read_status, 'search_excerpt'); assert.equal(unavailable.sources[0].text, undefined);
  assert.deepEqual(unavailable.errors, [{ stage: 'read', code: 'research_reader_unavailable' }]);
});

test('failed reads keep search excerpts with fixed errors, stop remaining reads and hide upstream details', async () => {
  let calls = 0;
  const run = createResearchWeb(() => ({ async search() { return result([source('https://one.com/a'), source('https://two.com/b')]); },
    async fetch() { calls++; throw Object.assign(new Error('secret endpoint sk_abcdefghi123456'), { code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }); } }));
  const output = await run({ queries: ['研究'], read_limit: 2 });
  assert.equal(calls, 1); assert.equal(output.counts.read, 0); assert.equal(output.counts.read_attempts, 1);
  assert.equal(output.errors[0].code, 'research_reader_unavailable'); assert.doesNotMatch(JSON.stringify(output), /secret endpoint|sk_/);
  assert.equal(output.sources.every(s => s.read_status === 'search_excerpt'), true);
});

test('private redirect, non-success HTTP and unrecognized bodies are not accepted as page content', async () => {
  for (const bad of [page('https://127.0.0.1/private'), { ...page('https://example.com/a'), statusCode: 403 },
    { ...page('https://example.com/a'), body: { kind: 'image', content: 'not text' } }]) {
    const output = await createResearchWeb(() => ({ async search() { return result([source('https://example.com/a')]); }, async fetch() { return bad; } }))({ queries: ['研究'], read_limit: 1 });
    assert.equal(output.counts.read, 0); assert.equal(output.errors.length, 1); assert.equal(output.sources[0].text, undefined);
  }
});

test('search service failures surface a safe code and never try another provider or next query', async () => {
  let calls = 0;
  const run = createResearchWeb(() => ({ async search() { calls++; throw Object.assign(new Error('PRIVATE_UPSTREAM_DETAIL'), { code: 'WEB_PROVIDER_AMBIGUOUS' }); } }));
  await assert.rejects(run({ queries: ['a', 'b'] }), error => error.code === 'research_search_unavailable' && !error.message.includes('PRIVATE_'));
  assert.equal(calls, 1);
  await assert.rejects(createResearchWeb(() => null)({ queries: ['a'] }), { code: 'research_search_unavailable' });
});

test('cancellation ends a provider that ignores signals and prevents later calls', async () => {
  const controller = new AbortController(); let calls = 0;
  const run = createResearchWeb(() => ({ search() { calls++; setTimeout(() => controller.abort(), 5); return new Promise(() => {}); } }), { timeoutMs: 100 });
  await assert.rejects(run({ queries: ['a', 'b'], signal: controller.signal }), { code: 'research_cancelled' });
  assert.equal(calls, 1);
  await assert.rejects(run({ queries: [], signal: controller.signal }), { code: 'research_cancelled' });
});

test('step deadline ends an unresponsive search without retry', async () => {
  let calls = 0;
  const run = createResearchWeb(() => ({ search() { calls++; return new Promise(() => {}); } }), { timeoutMs: 5 });
  await assert.rejects(run({ queries: ['a'] }), { code: 'research_timeout' }); assert.equal(calls, 1);
});
