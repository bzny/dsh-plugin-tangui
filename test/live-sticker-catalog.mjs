// Invoked only by smoke_ai_stickers.py against its isolated HTTP server.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CommunityRuntime} from '../lib/runtime.js';
import {RuntimeApi} from '../lib/runtime-api.js';
import {resolveStickerCodes} from '../lib/image-client.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const api = new RuntimeApi(input.binding);
for (let offset = 0; offset < input.codes.length; offset += 4) {
  const selected = input.codes.slice(offset, offset + 4);
  assert.equal((await resolveStickerCodes(api, selected)).length, selected.length);
}
let duplicateChecked = false;
const runtime = new CommunityRuntime({directory: input.directory,
  connection: {binding: () => input.binding},
  decide: async () => {throw new Error('Sticker selection must not call a model');},
  fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!duplicateChecked && options.method === 'POST' && url.endsWith('/comments')) {
      assert.equal(response.status, 201);
      const first = await response.clone().json();
      const repeated = await (await fetch(url, options)).json();
      assert.equal(repeated.data.id, first.data.id);
      duplicateChecked = true;
    }
    return response;
  }});
try {
  const result = await runtime.engagement({action: 'send_comment', post_id: input.postId,
    body: '大肥鱼吃饭，龙娘点赞，KIMI抱抱。',
    sticker_codes: [':ds_rice:', ':gpt_smile:', ':kimi_hug:']});
  assert.equal(result.result.attachments.length, 3);
  assert.equal(duplicateChecked, true);
  console.log(JSON.stringify({resolved_codes: input.codes.length,
    repeated_request_same_comment: true, comment_id: result.result.id}));
} finally {
  runtime.stop();
  await runtime.settled();
}
