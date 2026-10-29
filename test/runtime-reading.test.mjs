import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommunityRuntime } from '../lib/runtime.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.test-work');
const fields = ['role', 'manager_address', 'speaking_style', 'interests', 'participation_style', 'boundaries', 'memory_notes'];
function fixture(t, count = 4) {
  mkdirSync(ROOT, {recursive:true}); const directory = mkdtempSync(join(ROOT, 'reading-'));
  const actor = {id:'reader',kind:'ai',name:'阅读伙伴'}, binding = {baseUrl:'http://127.0.0.1:4999',actorId:actor.id,token:'FAKE_ONLY',scopes:['posts:read','comments:write','events:read']};
  const persona = {description:'喜欢游戏，但现在全量阅读',effective:Object.fromEntries(fields.map(k => [k,k === 'interests' ? '游戏' : '']))};
  const remote = {posts:Array.from({length:count},(_,i) => ({id:`post-${i+1}`,seq:i+1,title:`帖子${i+1}`,body:'与兴趣无关的内容',author:{id:'human',kind:'human'}})),
    calls:[],contexts:[],events:[],writes:[],accepted:new Map(),reserved:new Set(),full:new Set(),mediaPending:new Set(),videoPosts:new Set(),participate:false,badCursor:false};
  const send = (data, extra = {}) => ({ok:true,status:200,json:async()=>({data,...extra})});
  const error = (code,status=409) => ({ok:false,status,json:async()=>({error:{code}})});
  const fetchImpl = async (url,request) => {
    const u = new URL(url), path = u.pathname, body = request.body ? JSON.parse(request.body) : null;
    remote.calls.push({path,query:u.searchParams,body,key:request.headers['Idempotency-Key']});
    if (path === '/api/v1/me') return send({actor,scopes:binding.scopes});
    if (path === '/api/v1/capabilities') return send({features:{reading_after:true,discovery:true}});
    if (path === '/api/v1/agent/preferences') return send({community:{configured:true,paused:!!remote.paused,proactive_comments:true,reply_to_interactions:true,keywords:'不会命中的旧关键词',reply_remaining:null},diary:{timezone:'Asia/Shanghai'}});
    if (path === '/api/v1/agent/configuration') return send({actor,persona});
    if (path === '/api/v1/agent/control/acquire') return send({actor_id:actor.id,active:true,owned_by_current_grant:true,epoch:1,server_time:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()});
    if (path === '/api/v1/agent/control/release') return send({active:false});
    if (path === '/api/v1/events') return send(remote.events,{next_cursor:remote.events.at(-1)?.id || '0'});
    if (path === '/api/v1/posts') {
      const after = Number(u.searchParams.get('after')), rows = remote.posts.filter(p => p.seq > after), page = rows.slice(0,2);
      return send(page,{next_cursor:remote.badCursor ? String(after) : String(page.at(-1)?.seq ?? after),has_more:rows.length > 2});
    }
    const media=/^\/api\/v1\/media\/assets\/(asset-post-\d+)\/context$/.exec(path);
    if(media) return send({asset_id:media[1],state:'ready',frame_interval_seconds:3,summary:'公开的视频理解材料',
      frames:[{index:0,time:0,description:'测试画面'}],segments:[],next_cursor:null});
    const match = /^\/api\/v1\/posts\/(post-\d+)(?:\/(comments|participation))?$/.exec(path);
    if (!match) throw new Error(`Unexpected fixture path ${path}`);
    const [,id,kind] = match, post = remote.posts.find(p => p.id === id);
    if (!kind) {
      if(!post) return error('not_found',404);
      if(remote.mediaPending.has(id))remote.videoPosts.add(id);
      return send(remote.videoPosts.has(id) ? {...post,content:[{type:'video',asset_id:`asset-${id}`,context_state:remote.mediaPending.has(id)?'processing':'ready'}]} : post);
    }
    if (kind === 'participation') { if (remote.full.has(id)) return error('participation_full'); remote.reserved.add(id); return send({post_id:id,reserved:true}); }
    if (request.method === 'GET') return send([],{next_cursor:null});
    const key = request.headers['Idempotency-Key']; remote.writes.push({id,key,body});
    if (remote.accepted.has(key)) return send(remote.accepted.get(key));
    if (!remote.reserved.has(id)) return error('participation_required');
    const receipt = {id:`reply-${id}`,status:'published'}; remote.accepted.set(key,receipt); return send(receipt);
  };
  const instances = [], make = () => {
    const runtime = new CommunityRuntime({directory,connection:{binding:()=>binding},fetchImpl,decide:async context => {
      remote.contexts.push(context); const participate = typeof remote.participate === 'function' ? remote.participate(context) : remote.participate;
      if(remote.afterModel) await remote.afterModel(runtime);
      return {participate,body:participate ? '具体补充' : '',reflection:remote.reflection || '',decision_note:participate ? '回答具体问题' : '已有同一观点，不重复回应'};
    }}); instances.push(runtime); return runtime;
  };
  const run = async (runtime,options={}) => { runtime.start(options); await runtime.settled(); return runtime.publicStatus(); };
  t.after(async()=>{for(const runtime of instances){runtime.stop();await runtime.settled();}assert.ok(resolve(directory).startsWith(ROOT+sep));rmSync(directory,{recursive:true});});
  return {remote,make,run};
}
const mention = (id,kind='human') => ({id:String(id),type:'post.mentioned',author_id:kind==='human'?'human':'other-ai',author_kind:kind,reply_to_actor_id:'reader',post_id:'post-1',resource_id:'post-1'});

test('reads all paginated new posts across restarts without interests or saved keywords',async t=>{
  const f=fixture(t,5); f.remote.posts[1].author={id:'reader',kind:'ai'};
  for(let i=0;i<6;i++) assert.equal((await f.run(f.make())).error,null);
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-1','post-3','post-4','post-5']);
  const runtime=f.make(); assert.equal(runtime.state.reading_cursor,'5');
  assert.equal(f.remote.calls.some(c=>c.path.includes('/discovery/')),false);
  assert.ok(f.remote.calls.filter(c=>c.path==='/api/v1/posts').every(c=>!c.query.has('q')&&!c.query.has('interests')));
  assert.equal(runtime.publicStatus().last_decision.decision_note,'已有同一观点，不重复回应');
  assert.equal(runtime.state.model_calls,4); assert.equal(runtime.diary.status().entry_count,0);
  f.remote.posts.push({id:'post-6',seq:6,title:'新到帖子',body:'新内容',author:{id:'human',kind:'human'}});
  await f.run(runtime); assert.equal(f.remote.contexts.at(-1).post.id,'post-6');
});

test('reading budget stops new calls without skipping unread posts and a raised allowance resumes',async t=>{
  const f=fixture(t,3), runtime=f.make();
  for(let i=0;i<4;i++) await f.run(runtime,{max_model_calls:2});
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-1','post-2']);
  await f.run(runtime,{max_model_calls:3}); assert.equal(f.remote.contexts.at(-1).post.id,'post-3'); assert.equal(runtime.state.model_calls,3);
});

test('participation-full original is preserved while other posts are read, then submitted with its original key',async t=>{
  const f=fixture(t,3), runtime=f.make(); f.remote.participate=c=>c.post.id==='post-1'; f.remote.full.add('post-1');
  await f.run(runtime); const key=runtime.state.deferred_pending[0].key;
  for(let i=0;i<4;i++) await f.run(runtime);
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-1','post-2','post-3']); assert.equal(f.remote.accepted.size,0);
  assert.equal(runtime.state.deferred_pending[0].key,key); assert.equal(runtime.state.reading_cursor,'3');
  f.remote.full.clear(); await f.run(runtime);
  assert.equal(f.remote.accepted.size,1); assert.equal(f.remote.accepted.has(key),true); assert.equal(f.remote.contexts.length,3);
  assert.ok(f.remote.writes.every(w=>!Object.hasOwn(w.body,'decision_note')&&!Object.hasOwn(w.body,'reflection')));
});

test('a later human mention reconsiders a browse skip while AI mentions and duplicate successful replies do not',async t=>{
  const f=fixture(t,1); await f.run(f.make());
  f.remote.events=[mention(1,'ai')]; await f.run(f.make()); assert.equal(f.remote.contexts.length,1);
  f.remote.participate=true; f.remote.events.push(mention(2)); await f.run(f.make());
  assert.equal(f.remote.contexts.length,2); assert.equal(f.remote.contexts.at(-1).trigger.kind,'human_mention'); assert.equal(f.remote.accepted.size,1);
  f.remote.events.push(mention(3)); await f.run(f.make()); assert.equal(f.remote.contexts.length,2); assert.equal(f.remote.accepted.size,1);
});

test('legacy browse skips can answer a human mention, but a durable successful reply remains deduplicated',async t=>{
  for(const succeeded of [false,true]){
    const f=fixture(t,1), runtime=f.make(); runtime.commit({completed:['browse:post-1']});
    if(succeeded)runtime.diary.record({id:'old-event:reply',occurred_at:'2026-10-29T00:00:00Z',kind:'comment_submitted',reaction:'replied',resource:{post_id:'post-1'},reply:{id:'old-reply',body:'旧回应',status:'published'}});
    f.remote.participate=true; f.remote.events=[mention(1)]; await f.run(runtime);
    assert.equal(f.remote.contexts.length,succeeded?0:1); assert.equal(f.remote.accepted.size,succeeded?0:1);
  }
});

test('a pending media context does not starve later pages and is read once when ready',async t=>{
  const f=fixture(t,4), runtime=f.make(); f.remote.mediaPending.add('post-1');
  for(let i=0;i<5;i++)await f.run(runtime);
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-2','post-3','post-4']); assert.equal(runtime.state.reading_cursor,'4');
  assert.deepEqual(runtime.state.reading_waiting,['post-1']); f.remote.mediaPending.clear(); await f.run(runtime); await f.run(runtime);
  assert.equal(f.remote.contexts.filter(c=>c.post.id==='post-1').length,1); assert.deepEqual(runtime.state.reading_waiting,[]);
});

test('invalid pagination preserves the prior cursor without invoking the model',async t=>{
  const f=fixture(t,4), runtime=f.make(); f.remote.badCursor=true; await f.run(runtime);
  assert.equal(runtime.publicStatus().error.code,'invalid_reading_cursor'); assert.equal(runtime.state.reading_cursor,undefined); assert.equal(f.remote.contexts.length,0);
});

test('a waiting video mention is saved while later interactions continue, survives restart and is handled once when ready',async t=>{
  const f=fixture(t,2); f.remote.mediaPending.add('post-1');
  f.remote.events=[mention(1),{...mention(2),post_id:'post-2',resource_id:'post-2'}];
  const first=f.make(); await f.run(first);
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-2']);
  assert.equal(first.state.cursor,'2'); assert.equal(first.publicStatus().observation.waiting_video_events,1);
  const saved=JSON.parse(readFileSync(first.stateFile,'utf8'));
  assert.deepEqual(saved.waiting_events.map(e=>e.id),['1']);
  const resumed=f.make(); await f.run(resumed);
  assert.equal(f.remote.contexts.length,1); assert.equal(resumed.publicStatus().observation.last_check.model_calls,0);
  f.remote.mediaPending.clear(); await f.run(resumed); await f.run(f.make());
  assert.deepEqual(f.remote.contexts.map(c=>c.post.id),['post-2','post-1']);
  assert.equal(f.remote.contexts.at(-1).trigger.kind,'human_mention');
  assert.equal(f.remote.contexts.at(-1).post.video_material[0].frames.length,1);
  assert.equal(resumed.state.cursor,'2'); assert.deepEqual(resumed.state.waiting_events,[]);
});

test('deferred duplicate mentions share a decision and a removed video retires without model work',async t=>{
  const f=fixture(t,2); f.remote.mediaPending.add('post-1'); f.remote.events=[mention(1),mention(2)];
  await f.run(f.make()); assert.equal(f.remote.contexts.length,1); // unrelated second post
  const runtime=f.make(); assert.equal(runtime.state.waiting_events.length,2);
  f.remote.mediaPending.clear(); await f.run(runtime); await f.run(runtime);
  assert.equal(f.remote.contexts.filter(c=>c.post.id==='post-1').length,1);
  assert.deepEqual(runtime.state.waiting_events,[]);
  const other=fixture(t,1); other.remote.mediaPending.add('post-1'); other.remote.events=[mention(1)];
  await other.run(other.make()); other.remote.posts=[];
  const restarted=other.make(); await other.run(restarted);
  assert.equal(other.remote.contexts.length,0); assert.deepEqual(restarted.state.waiting_events,[]);
});

test('waiting video interactions respect changed account policy and resume with their original trigger',async t=>{
  const f=fixture(t,1); f.remote.mediaPending.add('post-1'); f.remote.events=[mention(1)];
  await f.run(f.make()); f.remote.mediaPending.clear(); f.remote.paused=true;
  const runtime=f.make(); await f.run(runtime);
  assert.equal(f.remote.contexts.length,0); assert.equal(runtime.state.waiting_events.length,1);
  f.remote.paused=false; await f.run(runtime);
  assert.equal(f.remote.contexts.length,1); assert.equal(f.remote.contexts[0].trigger.kind,'human_mention');
});

test('a complete answer reaches disk before connection recovery; a new instance reuses its body and key',async t=>{
  const f=fixture(t,1); f.remote.participate=true;
  f.remote.afterModel=async runtime=>{
    runtime.connectionReady=async()=>{throw Object.assign(new Error('simulated offline after generation'),{code:'network_error'});};
  };
  const runtime=f.make(); await f.run(runtime);
  const saved=JSON.parse(readFileSync(runtime.stateFile,'utf8'));
  assert.equal(saved.pending.payload.body,'具体补充'); assert.equal(saved.pending.attempted,undefined);
  assert.equal(saved.model_attempt,null); assert.equal(f.remote.accepted.size,0);
  f.remote.afterModel=null;
  const restarted=f.make(); await f.run(restarted); await f.run(restarted);
  assert.equal(f.remote.contexts.length,1); assert.equal(f.remote.accepted.size,1);
  assert.ok(f.remote.writes.every(w=>w.key===saved.pending.key && w.body.body===saved.pending.payload.body));
});

test('a declined decision reaches disk before diary storage failure and is not generated again',async t=>{
  const f=fixture(t,1); f.remote.reflection='保存在本机的感想';
  f.remote.afterModel=async runtime=>{runtime.diary.record=()=>{throw new Error('simulated diary I/O failure');};};
  const runtime=f.make(); await f.run(runtime);
  const saved=JSON.parse(readFileSync(runtime.stateFile,'utf8'));
  assert.ok(saved.completed.includes('browse:post-1')); assert.equal(saved.model_attempt,null);
  assert.equal(saved.pending_reflection.reflection,'保存在本机的感想');
  f.remote.afterModel=null; const resumed=f.make(); await f.run(resumed); assert.equal(f.remote.contexts.length,1);
  assert.equal(resumed.diary.status().entry_count,1); assert.equal(resumed.state.pending_reflection,null);
});

test('empty checks expose zero calls, new interactions expose the reason and incomplete prior calls are visible',async t=>{
  const f=fixture(t,0), runtime=f.make();
  let status=await f.run(runtime); assert.equal(status.observation.last_check.model_calls,0);
  assert.equal(status.observation.last_check.reason,'no_new_content'); assert.equal(status.observation.last_trigger,null);
  f.remote.posts.push({id:'post-1',seq:1,title:'测试',body:'公开正文',author:{id:'human',kind:'human'}});
  f.remote.events=[mention(1)]; status=await f.run(runtime);
  assert.equal(status.observation.last_check.model_calls,1); assert.equal(status.observation.last_trigger.kind,'human_mention');
  assert.equal(status.observation.last_trigger.call_number,1);
  status=await f.run(runtime); assert.equal(status.observation.last_check.model_calls,0);
  assert.equal(status.observation.last_trigger.kind,'human_mention');
  runtime.commit({model_attempt:{kind:'reply',at:'2026-10-29T00:00:00Z',post_id:'post-1',call_number:2,status:'generating'}});
  const restarted=f.make(); assert.equal(restarted.publicStatus().observation.interrupted_model.kind,'reply');
  assert.equal(f.remote.contexts.length,1,'loading status must not launch model work');
});

test('failed deferred-event persistence cannot advance the cursor or lose the notification',async t=>{
  const f=fixture(t,1); f.remote.mediaPending.add('post-1'); f.remote.events=[mention(1)];
  const runtime=f.make(), commit=runtime.commit.bind(runtime);
  runtime.commit=patch=>{if(patch.waiting_events)throw new Error('simulated storage failure'); return commit(patch);};
  await f.run(runtime); assert.equal(runtime.state.cursor,'0'); assert.equal(f.remote.contexts.length,0);
  const restarted=f.make(); await f.run(restarted);
  assert.equal(restarted.state.cursor,'1'); assert.deepEqual(restarted.state.waiting_events.map(e=>e.id),['1']);
});
