import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {EngagementClient, validateEngagement, definiteEngagementRejection} from '../lib/engagement-client.js';
import {RuntimeApi, fail, publicError} from '../lib/runtime-api.js';
import {CommunityRuntime} from '../lib/runtime.js';
import {registerRuntimeTool} from '../lib/runtime-tool.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const support = {action:'support_post', post_id:'post-test', amount:2};
const supported = {id:'support-test', post_id:'post-test', amount:2, total_tokens:2, my_tokens:2, remaining_tokens:0, wallet_balance:48};
const wallet = {currency:'TOKEN', balance:50, registration_bonus:50, spent_total:0, received_total:7, ai_spending_enabled:false};
const like = {action:'set_like', target_type:'post', target_id:'post-test', liked:true};

test('strict engagement inputs reject coercions and invalid Unicode lengths', () => {
  const invalid = [null, [], {action:[]}, ...[true, 1.5, 0, 3].map(amount => ({...support, amount})),
    {...support, actor_id:'other'}, {...support, post_id:'../other'},
    ...[undefined, null, 0, 1, 'true', 'false', [], {}].map(liked => ({...like, liked})),
    ...['video', 'POST', null, []].map(target_type => ({...like, target_type})),
    {...like, target_id:'../other'}, {...like, post_id:'post-test'}, {...like, actor_id:'other'},
    ...[['from_ms',null],['from_ms',true],['cursor',null],['cursor','-1'],['limit',null],['limit',501],['to_ms',-1]].map(([k,v]) => ({action:'danmaku',post_id:'post-test',[k]:v})),
    ...[['at_ms',0.5],['body','🙂'.repeat(101)],['body',' '],['mode',[]],['mode',null],['size',null],['color','red']].map(([k,v]) => ({action:'send_danmaku',post_id:'post-test',at_ms:1,body:'hi',[k]:v}))];
  for (const value of invalid) assert.throws(() => validateEngagement(value), {code:'invalid_engagement_input'});
  assert.equal(validateEngagement({action:'send_danmaku',post_id:'post-test',at_ms:1,body:'🙂'.repeat(100)}).body.length,200);
  assert.deepEqual(validateEngagement(like),like);
  assert.deepEqual(validateEngagement({...like,target_type:'comment',liked:false}),{...like,target_type:'comment',liked:false});
});

test('explicit transport methods and one-page time window never autofetch or auto-write', async () => {
  const calls=[];
  const api = {data:async path => {calls.push({path}); return wallet;}, request:async path => {calls.push({path}); return {data:[],next_cursor:'8',latest_cursor:'9',duration_ms:30000};}};
  const client = new EngagementClient(api, {write:async (path,body,key,method='POST') => {
    calls.push({path,body,key,method});
    return path==='/api/v1/engagement/likes' ? {...body,like_count:body.liked ? 1 : 0} : method==='DELETE' ? {id:'dm-test',status:'hidden'} : path.endsWith('/tokens') ? supported : {...body,id:'dm-test',post_id:'post-test'};
  }});
  assert.deepEqual(await client.wallet(),wallet);
  const page=await client.danmaku('post-test',{from_ms:2000,to_ms:4000,cursor:'7',limit:1});
  assert.deepEqual(page.window,{from_ms:2000,to_ms:4000});
  assert.equal(page.next_cursor,'8'); assert.equal(page.latest_cursor,'9'); assert.match(page.notice,/不是字幕/);
  assert.equal(calls.length,2);
  await client.supportPost('post-test',2,'fixed-key-1');
  assert.deepEqual(calls.at(-1),{path:'/api/v1/posts/post-test/tokens',body:{amount:2},key:'fixed-key-1',method:'POST'});
  const sent=await client.sendDanmaku('post-test',10,' \t'+'🙂'.repeat(100)+' \n','fixed-key-2',{color:'#abcdef'});
  assert.equal(calls.at(-1).body.color,'#ABCDEF');
  assert.equal(sent.body,'🙂'.repeat(100)); assert.equal(calls.at(-1).body.body,sent.body);
  await client.deleteDanmaku('post-test','dm-test','fixed-key-3');
  assert.deepEqual(calls.at(-1),{path:'/api/v1/posts/post-test/danmaku/dm-test',body:undefined,key:'fixed-key-3',method:'DELETE'});
  const liked = await client.setLike('post','post-test',true,'fixed-key-5');
  assert.deepEqual(liked,{target_type:'post',target_id:'post-test',liked:true,like_count:1});
  assert.deepEqual(calls.at(-1),{path:'/api/v1/engagement/likes',body:{target_type:'post',target_id:'post-test',liked:true},key:'fixed-key-5',method:'PUT'});
  await client.setLike('comment','comment-test',false,'fixed-key-6');
  assert.deepEqual(calls.at(-1),{path:'/api/v1/engagement/likes',body:{target_type:'comment',target_id:'comment-test',liked:false},key:'fixed-key-6',method:'PUT'});
  await assert.rejects(() => new EngagementClient(api).supportPost('post-test',1,'fixed-key-4'),{code:'control_required'});
  await assert.rejects(() => new EngagementClient(api).setLike('post','post-test',true,'fixed-key-7'),{code:'control_required'});
});

test('like responses must match the approved target and boolean state with a valid count',async()=>{
  const result={target_type:'post',target_id:'post-test',liked:true,like_count:1};
  for(const bad of [null, [], {...result,target_type:'comment'}, {...result,target_id:'other'}, {...result,liked:false},
    {...result,liked:1}, ...[-1, 0.5, true, '1', null, undefined].map(like_count=>({...result,like_count}))]) {
    const client=new EngagementClient({}, {write:async()=>bad});
    await assert.rejects(()=>client.execute(like,'fixed-key-1'),{code:'invalid_engagement_response'});
  }
  await assert.rejects(()=>new EngagementClient({}, {write:async()=>result}).execute(like),{code:'invalid_engagement_input'});
});

test('server rejection marker cannot confuse local cancellation with a rejected write', async () => {
  const api=new RuntimeApi({baseUrl:'http://127.0.0.1:4999',fetchImpl:async () => ({ok:false,status:429,json:async () => ({error:{code:'danmaku_rate_limited',retry_after_seconds:15,message:'PRIVATE_UPSTREAM'}})})});
  await assert.rejects(() => api.data('/api/v1/posts/post-test/danmaku'), error => {
    assert.equal(error.code,'danmaku_rate_limited'); assert.equal(error.retry_after_seconds,15);
    assert.equal(definiteEngagementRejection(error),true); assert.equal(publicError(error).retry_after_seconds,15);
    assert.doesNotMatch(JSON.stringify(publicError(error)),/PRIVATE/); return true;
  });
  for (const code of ['run_stopped','control_lost','invalid_engagement_response']) assert.equal(definiteEngagementRejection(fail(code,'local')),false);
  assert.equal(definiteEngagementRejection({http_rejected:true,status:500}),false);
  assert.equal(definiteEngagementRejection({http_rejected:true,status:408}),false);
});

test('engagement business error codes survive DSH transport without upstream text',async()=>{
  for(const code of ['engagement_unavailable','social_unavailable','verified_account_required','token_wallet_unavailable','token_wallet_invalid',
    'video_duration_unavailable','invalid_token_amount','token_record_unavailable','invalid_limit','danmaku_delete_denied',
    'invalid_danmaku_time','invalid_danmaku_range','invalid_danmaku_style','invalid_danmaku','invalid_target']) {
    const api=new RuntimeApi({baseUrl:'http://127.0.0.1:4999',fetchImpl:async()=>({ok:false,status:409,json:async()=>({error:{code,message:'PRIVATE_UPSTREAM'}})})});
    await assert.rejects(()=>api.data('/api/v1/tokens/wallet'),error=>{assert.equal(error.code,code);assert.doesNotMatch(error.message,/PRIVATE/);return true;});
  }
});

function fixture(t) {
  const directory=join(ROOT,`engagement-${randomUUID()}`); mkdirSync(directory,{recursive:true});
  const binding={baseUrl:'http://127.0.0.1:4999',actorId:'ai-test',token:'MOCK_ONLY',scopes:['posts:read','comments:write','events:read']};
  const actor={id:'ai-test',name:'测试',kind:'ai'};
  const remote={calls:[],writes:[],accepted:new Map(),likes:new Map(),held:null,claims:0,releases:0,modelCalls:0,lost:false,rejection:null,onWrite:null};
  const send=(data,extra={}) => ({ok:true,status:200,json:async()=>({data,...extra})});
  const error=(code,status=409) => ({ok:false,status,json:async()=>({error:{code}})});
  const lease=()=>({actor_id:actor.id,active:true,owned_by_current_grant:true,epoch:3,server_time:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),renew_after_seconds:15});
  const fetchImpl=async (url,request) => {
    const path=new URL(url).pathname,body=request.body ? JSON.parse(request.body) : undefined;
    remote.calls.push({path,body,method:request.method,headers:request.headers});
    if(path==='/api/v1/me')return send({actor,scopes:binding.scopes});
    if(path==='/api/v1/capabilities')return send({features:{}});
    if(path==='/api/v1/agent/control/acquire') {if(remote.held)return error('control_busy');remote.held=body.instance_id;remote.claims++;return send(lease());}
    if(path==='/api/v1/agent/control/renew')return send(lease());
    if(path==='/api/v1/agent/control/release') {remote.held=null;remote.releases++;return send({active:false});}
    if(path==='/api/v1/agent/preferences')return remote.preferences ? send(structuredClone(remote.preferences)) : error('not_found',404);
    if(path==='/api/v1/events')return send([],{next_cursor:'0'});
    if(path==='/api/v1/posts')return send([]);
    if(path==='/api/v1/agent/configuration')return send({actor,persona:{description:'测试伙伴',effective:{}}});
    if(path==='/api/v1/tokens/wallet')return send(wallet);
    if(path==='/api/v1/posts/post-test/danmaku' && request.method==='GET')return send([],{next_cursor:null,latest_cursor:'0',duration_ms:30000});
    if(path==='/api/v1/engagement/likes' || path==='/api/v1/posts/post-test/tokens' || path.startsWith('/api/v1/posts/post-test/danmaku')) {
      assert.equal(request.headers['X-AI-Instance-ID'],remote.held);assert.ok(remote.held);assert.equal(request.headers['X-AI-Control-Epoch'],'3');
      const key=request.headers['Idempotency-Key'];remote.writes.push({path,body,key,method:request.method});
      if(remote.rejection)return error(remote.rejection.code,remote.rejection.status);
      if(remote.accepted.has(key)){assert.deepEqual(remote.accepted.get(key).body,body);return send(remote.accepted.get(key).result);}
      let result;
      if(path==='/api/v1/engagement/likes') {
        assert.equal(request.method,'PUT');
        remote.likes.set(`${body.target_type}:${body.target_id}`,body.liked);
        result={...body,like_count:body.liked ? 1 : 0};
      } else result=path.endsWith('/tokens') ? supported : request.method==='DELETE' ? {id:'dm-test',status:'hidden'} : {...body,id:'dm-test',post_id:'post-test'};
      remote.accepted.set(key,{body,result});
      if(remote.onWrite)remote.onWrite();
      if(remote.lost){remote.lost=false;throw new Error('lost mock response');}
      return send(result);
    }
    return error('not_found',404);
  };
  const make=()=>new CommunityRuntime({directory,connection:{binding:()=>binding},fetchImpl,decide:async()=>{remote.modelCalls++;throw new Error('unexpected model');}});
  const runtime=make();
  t.after(async()=>{runtime.stop();await runtime.settled();assert.ok(resolve(directory).startsWith(ROOT+ '\\'));rmSync(directory,{recursive:true});});
  return {runtime,make,remote};
}

test('paused companion blocks new social writes while keeping read and retraction tools available', async t => {
  const f = fixture(t); f.remote.preferences = { community: { paused: true, allow_token_support: true }, diary: {} };
  for (const args of [support, like, {action:'send_danmaku',post_id:'post-test',at_ms:1200,body:'暂停时不发送'}]) {
    await assert.rejects(() => f.runtime.engagement(args), {code:'community_paused'});
  }
  assert.equal(f.remote.writes.length, 0);
  assert.deepEqual((await f.runtime.engagement({action:'token_wallet'})).result, wallet);
  await f.runtime.engagement({...like, liked:false});
  await f.runtime.engagement({action:'delete_danmaku',post_id:'post-test',danmaku_id:'dm-test'});
  assert.equal(f.remote.writes.length, 2); assert.equal(f.remote.preferences.community.allow_token_support, true);
  f.remote.preferences.community.paused = false;
  await f.runtime.engagement(support); assert.equal(f.remote.accepted.size, 3);
});

test('pause does not prevent reconciliation of an uncertain engagement with the original key', async t => {
  const f = fixture(t); f.remote.lost = true;
  await assert.rejects(() => f.runtime.engagement(support), {code:'network_error'});
  const key = f.runtime.state.pending_engagement.key;
  f.remote.preferences = {community:{paused:true},diary:{}};
  const restarted = f.make();
  assert.deepEqual((await restarted.engagement({action:'retry_engagement'})).result, supported);
  assert.equal(f.remote.accepted.size, 1); assert.equal(f.remote.writes.at(-1).key, key);
  assert.equal(restarted.state.pending_engagement, null);
});

test('reads do not claim control; single observation never supports, likes or sends danmaku',async t=>{
  const f=fixture(t);f.remote.held='other-controller';
  assert.deepEqual((await f.runtime.engagement({action:'token_wallet'})).result,wallet);
  await f.runtime.engagement({action:'danmaku',post_id:'post-test'});
  assert.equal(f.remote.claims,0);assert.equal(f.remote.writes.length,0);
  f.remote.held=null;f.runtime.start({max_model_calls:77});await f.runtime.settled();
  assert.equal(f.remote.writes.length,0);assert.equal(f.remote.modelCalls,0);
  await f.runtime.engagement(support);assert.equal(f.runtime.publicStatus().limits.max_model_calls,77);
});

test('lost response is durable; restart reuses key, never changes amount or calls model',async t=>{
  const f=fixture(t);f.remote.lost=true;
  await assert.rejects(()=>f.runtime.engagement(support),{code:'network_error'});
  const pending=JSON.parse(readFileSync(f.runtime.stateFile,'utf8')).pending_engagement;
  assert.deepEqual(pending.args,support);assert.equal(pending.uncertain,true);
  const restarted=f.make();
  await assert.rejects(()=>restarted.engagement({...support,amount:1}),{code:'engagement_pending'});
  assert.equal(f.remote.writes.length,1);
  f.remote.rejection={code:'ai_token_spending_disabled',status:403};
  await assert.rejects(()=>restarted.engagement({action:'retry_engagement'}),{code:'ai_token_spending_disabled'});
  assert.deepEqual(restarted.publicStatus().engagement.pending,support);
  f.remote.rejection=null;
  assert.deepEqual((await restarted.engagement({action:'retry_engagement'})).result,supported);
  assert.equal(f.remote.accepted.size,1);assert.equal(f.remote.modelCalls,0);
  assert.ok(f.remote.writes.every(x=>x.key===pending.key && x.body.amount===2));
  assert.equal(restarted.publicStatus().engagement.pending,null);
  assert.equal(restarted.publicStatus().model_calls,0);
});

test('first explicit rejection unlocks while cancellation after submission retains original',async t=>{
  const f=fixture(t);f.remote.rejection={code:'ai_token_spending_disabled',status:403};
  await assert.rejects(()=>f.runtime.engagement(support),{code:'ai_token_spending_disabled'});
  assert.equal(f.runtime.publicStatus().engagement.pending,null);
  f.remote.rejection=null;
  const controller=new AbortController();f.remote.onWrite=()=>controller.abort();
  await assert.rejects(()=>f.runtime.engagement(support,controller.signal),{code:'run_stopped'});
  assert.deepEqual(f.runtime.publicStatus().engagement.pending,support);
  f.remote.onWrite=null;
  assert.deepEqual((await f.make().engagement({action:'retry_engagement'})).result,supported);
  assert.equal(f.remote.accepted.size,1);
});

test('danmaku send and hide use same controlled explicit lifecycle',async t=>{
  const f=fixture(t);
  const sent=await f.runtime.engagement({action:'send_danmaku',post_id:'post-test',at_ms:1200,body:'好看'});
  assert.equal(sent.result.id,'dm-test');
  const removed=await f.runtime.engagement({action:'delete_danmaku',post_id:'post-test',danmaku_id:'dm-test'});
  assert.equal(removed.result.status,'hidden');assert.equal(f.remote.writes.at(-1).method,'DELETE');
  assert.equal(f.remote.claims,2);assert.equal(f.remote.releases,2);assert.equal(f.remote.modelCalls,0);
});

test('like and unlike use controlled PUT; lost response retry preserves the original outcome',async t=>{
  const f=fixture(t);
  f.remote.held='other-controller';
  await assert.rejects(()=>f.runtime.engagement(like),{code:'control_busy'});
  assert.equal(f.remote.writes.length,0);
  f.remote.held=null;f.remote.lost=true;
  await assert.rejects(()=>f.runtime.engagement(like),{code:'network_error'});
  const pending=JSON.parse(readFileSync(f.runtime.stateFile,'utf8')).pending_engagement;
  assert.deepEqual(pending.args,like);assert.equal(pending.uncertain,true);
  const restarted=f.make();
  await assert.rejects(()=>restarted.engagement({...like,liked:false}),{code:'engagement_pending'});
  await assert.rejects(()=>restarted.engagement({...like,target_type:'comment'}),{code:'engagement_pending'});
  assert.equal(f.remote.writes.length,1);
  const retried=await restarted.engagement({action:'retry_engagement'});
  assert.deepEqual(retried.result,{target_type:'post',target_id:'post-test',liked:true,like_count:1});
  assert.equal(f.remote.writes.at(-1).key,pending.key);assert.equal(f.remote.accepted.size,1);
  f.remote.lost=true;
  await assert.rejects(()=>restarted.engagement({...like,liked:false}),{code:'network_error'});
  const unlikePending=JSON.parse(readFileSync(restarted.stateFile,'utf8')).pending_engagement;
  assert.equal(unlikePending.args.liked,false);assert.notEqual(unlikePending.key,pending.key);
  const recovered=f.make();
  const removed=await recovered.engagement({action:'retry_engagement'});
  assert.deepEqual(removed.result,{target_type:'post',target_id:'post-test',liked:false,like_count:0});
  assert.equal(f.remote.writes.at(-1).key,unlikePending.key);
  // The original receipt is authoritative for this retry, not the current like state.
  recovered.commit({pending_engagement:pending});
  assert.deepEqual((await recovered.engagement({action:'retry_engagement'})).result,retried.result);
  assert.equal(f.remote.likes.get('post:post-test'),false);assert.equal(f.remote.accepted.size,2);
  assert.equal(f.remote.modelCalls,0);assert.equal(recovered.publicStatus().engagement.pending,null);
  const comment=await recovered.engagement({action:'set_like',target_type:'comment',target_id:'comment-test',liked:true});
  assert.equal(comment.result.target_type,'comment');assert.equal(f.remote.modelCalls,0);
});

test('DSH approval specifies concrete amount and retry target, preserving denial',async()=>{
  let tool,approval,guarded=0;
  const runtime={publicStatus:()=>({engagement:{pending:support}}),engagement:async args=>args};
  registerRuntimeTool({tools:{register:t=>{tool=t;}},on:(_,fn)=>{approval=fn;}},{runtime,connection:{publicStatus:()=>({})},guard:()=>{guarded++;}});
  const decision=await approval({name:tool.name,arguments:support},async()=>({kind:'allow'}));
  assert.equal(decision.kind,'ask');assert.match(decision.displayReason.zh,/post-test.*2.*TOKEN/);
  assert.equal((await approval({name:tool.name,arguments:support},async()=>({kind:'deny'}))).kind,'deny');
  const retry=await approval({name:tool.name,arguments:{action:'retry_engagement'}},async()=>({kind:'allow'}));
  assert.match(retry.displayReason.zh,/post-test.*2.*TOKEN/);
  assert.equal((await approval({name:tool.name,arguments:{action:'token_wallet'}},async()=>({kind:'allow'}))).kind,'allow');
  await tool.execute(support,{signal:new AbortController().signal});assert.equal(guarded,1);
});

test('DSH discovers like fields and approval names the exact like or unlike target, including retry',async()=>{
  let tool,approval,pending=like,guarded=0;
  const runtime={publicStatus:()=>({engagement:{pending}}),engagement:async args=>args};
  registerRuntimeTool({tools:{register:t=>{tool=t;}},on:(_,fn)=>{approval=fn;}},{runtime,connection:{publicStatus:()=>({})},guard:()=>{guarded++;}});
  assert.ok(tool.parameters.properties.action.enum.includes('set_like'));
  assert.deepEqual(tool.parameters.properties.target_type.enum,['post','comment']);
  assert.equal(tool.parameters.properties.liked.type,'boolean');
  assert.match(tool.description,/watch\/single never perform these actions/);
  for(const args of [like,{...like,target_type:'comment',target_id:'comment-test',liked:false}]) {
    pending=args;
    const pattern=args.liked ? /点赞帖子 post-test/ : /取消点赞评论 comment-test/;
    const decision=await approval({name:tool.name,arguments:args},async()=>({kind:'allow'}));
    assert.equal(decision.kind,'ask');assert.match(decision.displayReason.zh,pattern);
    const retry=await approval({name:tool.name,arguments:{action:'retry_engagement'}},async()=>({kind:'allow'}));
    assert.equal(retry.kind,'ask');assert.match(retry.displayReason.zh,pattern);
    assert.equal((await approval({name:tool.name,arguments:args},async()=>({kind:'deny'}))).kind,'deny');
    const result=await tool.execute(args,{signal:new AbortController().signal});assert.deepEqual(result.result,args);
  }
  assert.equal(guarded,2);
  await assert.rejects(()=>tool.execute({...like,post_id:'post-test'},{signal:new AbortController().signal}),{code:'invalid_engagement_input'});
});
