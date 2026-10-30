import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageMetadata,itemImages,readingImages,readPreview,imageModelContent,attachmentSelection,decisionAttachments,resolveStickerCodes,availableStickers,MAX_PREVIEW_BYTES,MAX_READING_IMAGES} from '../lib/image-client.js';
import {createRuntimeModel,parseDecision} from '../lib/runtime-model.js';
import {RuntimeApi} from '../lib/runtime-api.js';
import {registerRuntimeTool,validateRuntimeInput} from '../lib/runtime-tool.js';
import {EngagementClient,validateEngagement} from '../lib/engagement-client.js';

const image=(id='image_one',extra={})=>({type:'image',id,image_id:id,label:'上传者自述，不是识别事实',available:true,animated:false,width:320,height:200,...extra});
const discussion=(images=[image()])=>({post:{id:'post_one',body:'正文'},comments:[{id:'comment_one',attachments:images}],reply_to_comment_id:'comment_one'});

test('metadata never imports arbitrary URLs, scripts or secrets into model image requests',()=>{
  const metadata=imageMetadata(image('image_one',{preview_url:'https://attacker.test/steal',url:'file:///secret',secret:'PRIVATE'}));
  assert.deepEqual(Object.keys(metadata),['type','id','image_id','label','width','height','animated','available']);
  assert.equal(imageMetadata({...image(),image_id:'../secret'}),null);
  assert.equal(itemImages({attachments:[image(),{type:'video',id:'asset_one'}]}).length,1);
  const context=discussion([image(),image()]);context.post.attachments=[image('image_two')];
  assert.deepEqual(readingImages(context).map(i=>i.image_id),['image_one','image_two']);
});

test('preview transport keeps credentials on canonical same-origin URL, blocks redirects and bounds streams',async()=>{
  const calls=[];
  const api={baseUrl:'https://community.test',token:'TEST_ONLY',fetch:async(url,options)=>{calls.push({url,options});return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});}};
  const result=await readPreview(api,'image_one');assert.equal(result.mediaType,'image/png');assert.equal(result.data.length,3);
  assert.equal(calls[0].url,'https://community.test/api/v1/images/image_one/preview');assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.headers.authorization,'Bearer TEST_ONLY');
  await assert.rejects(()=>readPreview(api,'https://evil.test/pic'),{code:'invalid_resource'});assert.equal(calls.length,1);
  for(const response of [new Response('html',{headers:{'content-type':'text/html'}}),new Response('x',{status:403}),new Response('x',{headers:{'content-type':'image/png','content-length':String(MAX_PREVIEW_BYTES+1)}}),new Response(new Uint8Array(MAX_PREVIEW_BYTES+1),{headers:{'content-type':'image/png'}})]) {
    await assert.rejects(()=>readPreview({...api,fetch:async()=>response},'image_one'),{code:'image_unavailable'});
  }
});

test('unavailable and text-only pictures produce honest reading states without downloads',async()=>{
  let reads=0,saves=0;
  const services={loadImage:async()=>{reads++;},attachments:{saveImage:async()=>{saves++;}}};
  const result=await imageModelContent(discussion([image(),image('image_two',{available:false})]),{...services,modalities:['text']});
  assert.equal(reads,0);assert.equal(saves,0);assert.deepEqual(result.blocks,[]);
  assert.deepEqual(result.reading.observations.map(o=>o.status),['model_text_only','unavailable']);
});

test('default sticker catalog uses the declared policy ID without market assumptions, fallbacks or retries',async()=>{
  const calls=[];
  const result=await availableStickers(async path=>{calls.push(path);return {data:path.endsWith('/policy') ? {default_pack_id:'pack_default_faces'} : {id:'pack_default_faces',official:true,title:'默认',items:[{id:'sticker_one',label:'开心',available:true}]}};});
  assert.deepEqual(calls,['/api/v1/images/policy','/api/v1/stickers/packs/pack_default_faces']);assert.equal(result.length,1);
  for(const policy of [{}, {default_pack_id:'../private'}]) {
    let reads=0;assert.deepEqual(await availableStickers(async()=>{reads++;return {data:policy};}),[]);assert.equal(reads,1);
  }
});

test('preferred catalog consumes one chosen pack and stable names without loading the entire market',async()=>{
  const calls=[];
  const result=await availableStickers(async path=>{calls.push(path);return {data:path.endsWith('/policy') ?
    {default_pack_id:'pack_default_faces',recommended_stickers_path:'/api/v1/stickers/recommended'} :
    {id:'pack_ai_gpt',official:true,selection_source:'avatar',title:'龙娘',items:[
      {id:'sticker_gpt_hug',label:'尾巴给你抱',shortcode:':gpt_hug:',usage:'安慰',available:true},
      {id:'sticker_hidden',label:'不可用',shortcode:':gpt_mad:',available:false}]}};});
  assert.deepEqual(calls,['/api/v1/images/policy','/api/v1/stickers/recommended']);
  assert.equal(result.length,1);assert.equal(result[0].shortcode,':gpt_hug:');assert.equal(result[0].usage,'安慰');
  const decision=parseDecision('{"participate":true,"body":"","sticker_codes":[":gpt_hug:"]}');
  assert.deepEqual(decisionAttachments(decision,result),[{type:'sticker',id:'sticker_gpt_hug'}]);
  assert.throws(()=>decisionAttachments({...decision,sticker_codes:[':gpt_mad:']},result),{code:'sticker_code_unavailable'});
  assert.throws(()=>decisionAttachments({...decision,attachments:[{type:'sticker',id:'sticker_gpt_hug'}]},result));
  const literal=parseDecision('{"participate":true,"body":"代码示例 `:gpt_hug:`"}');
  assert.deepEqual(decisionAttachments(literal,result),[]);assert.equal(literal.body,'代码示例 `:gpt_hug:`');
});

test('explicit shortcodes resolve only to exact available catalog entries and preserve errors',async()=>{
  const reads=[];
  const api={data:async path=>{reads.push(path);return [{type:'sticker',id:'sticker_real',shortcode:':ds_rice:',available:true}];}};
  assert.deepEqual(await resolveStickerCodes(api,[':ds_rice:']),[{type:'sticker',id:'sticker_real'}]);
  assert.equal(new URL(reads[0],'https://example.test').searchParams.get('codes'),':ds_rice:');
  await assert.rejects(()=>resolveStickerCodes(api,[':gpt_hug:']),{code:'invalid_sticker_catalog'});
  await assert.rejects(()=>resolveStickerCodes(api,[':ds_rice:',':ds_rice:']),{code:'invalid_sticker_codes'});
  let writes=0;
  const input={action:'send_comment',post_id:'post_one',body:'',sticker_codes:[':ds_rice:']};
  assert.deepEqual(validateEngagement(input),input);
  await assert.rejects(()=>new EngagementClient({}, {write:async()=>{writes++;}}).execute(input,'original-key'),{code:'sticker_codes_not_resolved'});
  assert.equal(writes,0);
});

test('bounded image selection uses DSH attachment references, labels animation limits and omits excess',async()=>{
  const context=discussion();context.comments=Array.from({length:3},(_,c)=>({id:`c${c}`,attachments:Array.from({length:4},(_,i)=>image(`image_${c}_${i}`,{animated:i===0}))}));
  const saved=[],result=await imageModelContent(context,{modalities:['image'],loadImage:async id=>({data:new Uint8Array(8),mediaType:'image/png',name:id}),attachments:{saveImage:async input=>{saved.push(input);return {attachmentId:input.name,mediaType:input.mediaType};}}});
  assert.equal(saved.length,MAX_READING_IMAGES);assert.equal(result.reading.total_images,12);assert.equal(result.reading.omitted_images,12-MAX_READING_IMAGES);
  assert.equal(result.blocks.filter(b=>b.type==='image').length,MAX_READING_IMAGES);assert.ok(result.blocks.some(b=>b.text?.includes('动画首帧')));
});

test('a missing picture does not invent visuals or cause a second model call; selected effort and output stay intact',async()=>{
  const calls=[],saves=[];
  const model=createRuntimeModel(()=>({agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'test',reasoningEffort:'medium'})},attachments:{saveImage:async input=>{saves.push(input);return {attachmentId:'local-test-ref',mediaType:'image/png',width:10,height:10,bytes:1};}},llm:{prepareCall:async config=>({config,inputModalities:['text','image'],stream:async function*(request){calls.push(request);yield {type:'text-delta',index:0,text:'{"participate":false,"body":""}'};yield {type:'finish',reason:{kind:'stop'}};}})}}));
  const context=discussion([image(),image('image_two')]);let reads=0;
  await model(context,undefined,undefined,undefined,{loadImage:async id=>{reads++;if(id==='image_two')throw new Error('unavailable');return {data:new Uint8Array([1]),mediaType:'image/png',name:id};}});
  assert.equal(calls.length,1);assert.equal(calls[0].maxTokens,64000);assert.equal(calls[0].reasoningEffort,'medium');assert.equal(reads,2);assert.equal(saves.length,1);
  const content=calls[0].messages[0].content;assert.equal(content.filter(b=>b.type==='image').length,1);
  const sent=JSON.parse(content[0].text);assert.deepEqual(sent.image_reading.observations.map(o=>o.status),['preview_attached','preview_unavailable']);
  assert.ok(!JSON.stringify(context).includes('local-test-ref'));
});

test('sticker decisions accept only chosen IDs and never arbitrary URLs or generated attachments',()=>{
  const decision=parseDecision('{"participate":true,"body":"","attachments":[{"type":"sticker","id":"sticker_wave"}]}');
  assert.equal(decision.attachments.length,1);
  assert.throws(()=>parseDecision('{"participate":true,"body":"","attachments":[{"type":"image","id":"image_one"}]}'));
  assert.throws(()=>attachmentSelection(decision.attachments,{allowedStickers:new Set(['another'])}));
  assert.throws(()=>attachmentSelection([{type:'sticker',id:'sticker_wave',url:'https://evil.test'}]));
  assert.throws(()=>attachmentSelection([...decision.attachments,...decision.attachments]));
});

test('explicit image/sticker replies preserve exact approved attachments and request key',async()=>{
  const args={action:'send_comment',post_id:'post_one',body:'',attachments:[{type:'image',id:'image_one'},{type:'sticker',id:'sticker_one'}]};
  assert.deepEqual(validateEngagement(args),args);
  const writes=[],client=new EngagementClient({}, {write:async(path,body,key)=>{writes.push({path,body,key});return {...body,id:'comment_new',post_id:'post_one',status:'published'};}});
  await client.execute(args,'original-key');assert.equal(writes.length,1);assert.equal(writes[0].key,'original-key');assert.deepEqual(writes[0].body.attachments,args.attachments);
  assert.throws(()=>validateEngagement({...args,body:'',attachments:[]}));
  assert.throws(()=>validateEngagement({...args,attachments:[{type:'image',id:'../private'}]}));
});

test('tools advertise image/sticker operations and reject every retired video/danmaku operation before network',async()=>{
  let tool;registerRuntimeTool({on(){},tools:{register:value=>{tool=value;}}},{runtime:{},connection:{}});
  for(const action of ['image_context','sticker_packs','sticker_pack','send_comment']) assert.ok(tool.parameters.properties.action.enum.includes(action));
  for(const action of ['video_context','danmaku','send_danmaku','delete_danmaku']) {
    assert.ok(!tool.parameters.properties.action.enum.includes(action));assert.throws(()=>validateRuntimeInput({action}));
  }
  assert.throws(()=>validateRuntimeInput({action:'sticker_packs',scope:'everyone'}));
  let calls=0;const api=new RuntimeApi({baseUrl:'https://community.test',fetchImpl:async()=>{calls++;}});
  for(const path of ['/api/v1/media/policy','/api/v1/media/assets/a/context','/api/v1/posts/a/danmaku']) await assert.rejects(()=>api.request(path),{code:'video_disabled'});
  assert.equal(calls,0);
});
