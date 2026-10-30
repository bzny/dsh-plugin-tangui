import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaClient,readVideoContext,readPostVideos} from '../lib/media-client.js';
import {CommunityRuntime} from '../lib/runtime.js';
import {validateRuntimeInput} from '../lib/runtime-tool.js';

test('legacy media imports are inert and cannot start a video request or read a local file',async()=>{
  let reads=0;const network=()=>{reads++;throw new Error('network must not be used');};
  const client=new MediaClient({data:network,request:network},{write:network});
  for(const method of ['policy','upload','context','helper','submit']) await assert.rejects(()=>client[method]('C:/private.mp4'),{code:'video_disabled',status:410});
  await assert.rejects(()=>readVideoContext(network,'old-video'),{code:'video_disabled'});
  await assert.rejects(()=>readPostVideos(network,{content:[{type:'video'}]}),{code:'video_disabled'});
  assert.equal(reads,0);
});

test('runtime has no active video handlers or advertised video tool',()=>{
  assert.equal(CommunityRuntime.prototype.videoContext,undefined);
  assert.equal(CommunityRuntime.prototype.mediaClient,undefined);
  assert.throws(()=>validateRuntimeInput({action:'video_context',asset_id:'old-video'}),{code:'invalid_action'});
});
