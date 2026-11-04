import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ResearchJournal, serviceResearch, parseResearchPlan, parseResearchDecision, rememberResearchPublication } from '../lib/autonomous-research.js';
import { LocalDiary } from '../lib/local-diary.js';
import { CommunityRuntime } from '../lib/runtime.js';
import { flushDraftRequest } from '../lib/proactive-drafts.js';
import { createRuntimeModel } from '../lib/runtime-model.js';
import { readThoughtEntries } from '../lib/local-thoughts.js';

const ROOT = fileURLToPath(new URL('../.test-work/',import.meta.url));
const plan = (patch={}) => ({skip:false,topic:'合作游戏',question:'合作游戏如何保留独立判断？',previous_topic_id:null,related_post_id:null,seed_id:null,new_angle:'研究不同的信息共享机制',queries:[],...patch});
const decision = (patch={}) => ({action:'note',thought:'共同目标也需要每个参与者保留独立判断。',target_post_id:null,title:'',body:'',topics:[],new_question:'',difference:'',source_urls:[],...patch});
function fixture(t) {
  const directory = join(ROOT,'research-'+randomUUID()); mkdirSync(directory,{recursive:true});
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(ROOT))); rmSync(directory,{recursive:true,force:true}); });
  let now = Date.UTC(2026,10,4,4), seeds = [];
  const remote = {drafts:[],model:[],calls:[],searches:[],post:{id:'post-one',title:'合作游戏讨论',body:'如何设计合作游戏？',author:{id:'human-one'}}};
  const r = {mode:'watch',state:{identity:{base_url:'https://community.example',actor_id:'ai-one'},model_calls:0,replies:0,completed:[],cursor:'0'},
    preferences:{community:{auto_post:true,proactive_comments:true,draft_search_enabled:true,draft_interval_hours:3,draft_daily_limit:2,configured:true},diary:{}},
    actor:{id:'ai-one'},limits:{max_model_calls:10},abort:new AbortController(),binding:()=>({baseUrl:'https://community.example'}),
    wallNow:()=>now,isHostIdle:()=>true,researchRandom:()=>.5,checkActive(){this.abort.signal.throwIfAborted();},
    commit(v){this.state={...this.state,...structuredClone(v)};},budget(){assert.ok(this.state.model_calls<this.limits.max_model_calls);},
    phaseTo(){},noteModelCall(){},async refreshPreferences(){},pendingAllowed:CommunityRuntime.prototype.pendingAllowed,
    configuration:async()=>({description:'PRIVATE_TRANSCRIPT',effective:{role:'伙伴',speaking_style:'自然',interests:'合作游戏',memory_notes:'PRIVATE_MEMORY'}}),
    diary:new LocalDiary({directory,baseUrl:'https://community.example',actorId:'ai-one'}),
    lifeHost:{researchSessionId:()=> 'session-manager'},mind:{enabled:()=>false,researchSeeds:()=>seeds},
    async get(path){remote.calls.push(path);return path.includes('reading-context') ? {data:{post:remote.post,comments:[]}} : {data:[remote.post]};},
    api:{async data(){return {drafts:remote.drafts};}},
    async researchPlanModel(c){remote.model.push(c);return parseResearchPlan(JSON.stringify(plan()),c);},
    async researchWriteModel(c){remote.model.push(c);return parseResearchDecision(JSON.stringify(decision()),c);},
    async researchWeb(c){remote.searches.push(c);return {sources:[],counts:{queries:1,pages:0,read:0}};},
    async write(path,payload,key){remote.calls.push({path,payload,key});let d=remote.drafts.find(d=>d.key===key);if(!d){d={id:'draft-one',key,status:'pending',content:payload};remote.drafts.push(d);}return d;},
  };
  return {r,remote,seeds:v=>{seeds=v;},advance:()=>{now+=3*3600000;},async begin(){await serviceResearch(r);now+=3*3600000;return serviceResearch(r);},async finish(){for(let i=0;i<4&&r.state.research_job;i++)await serviceResearch(r);}};
}

test('interest-led task uses two model calls, saves a readable thought and never reads raw memory',async t=>{
  const f=fixture(t);await f.begin();assert.equal(f.r.state.research_job.stage,'sources');await f.finish();
  assert.equal(f.r.state.model_calls,2);assert.equal(f.r.state.research_last.outcome,'noted');
  assert.doesNotMatch(JSON.stringify(f.remote.model),/PRIVATE_/);
  const rows=[...f.r.diary.entries()];assert.equal(rows.length,1);assert.equal(rows[0].kind,'research');
  assert.equal(new ResearchJournal(f.r.diary.directory).list().length,1);
});

test('local abstract seed can inspire a task, and correction cancels it before search',async t=>{
  const f=fixture(t);f.seeds([{id:'seed-one',question:'游戏里怎样合作？',keywords:['合作'],at:'2026-11-04'}]);
  await f.begin();assert.equal(f.remote.model[0].local_questions.length,1);f.seeds([]);await serviceResearch(f.r);
  assert.equal(f.r.state.research_last.outcome,'source_changed');assert.equal(f.remote.searches.length,0);assert.equal(f.r.state.model_calls,1);
});

test('model parsers reject fabricated references, privacy leaks and unsupported actions',()=>{
  assert.throws(()=>parseResearchPlan(JSON.stringify(plan({related_post_id:'made-up'})),{posts:[]}));
  assert.throws(()=>parseResearchPlan(JSON.stringify(plan({queries:['api_key=sk_12345678901234567']})),{}));
  assert.throws(()=>parseResearchDecision(JSON.stringify(decision({action:'reply',target_post_id:'made-up',body:'回复'})),{posts:[],can_reply:true}));
  assert.throws(()=>parseResearchDecision(JSON.stringify(decision({action:'post',title:'标题',body:'正文',new_question:'新问题',difference:'新增'})),{can_post:false}));
  assert.throws(()=>parseResearchDecision(JSON.stringify(decision({action:'note',body:'不该公开'})),{}));
});

test('new topic enters the existing draft queue and lost acknowledgements reuse the original key',async t=>{
  const f=fixture(t);f.r.researchWriteModel=async c=>parseResearchDecision(JSON.stringify(decision({action:'post',title:'合作的新问题',body:'提出一个信息共享机制。',new_question:'怎样共享？',difference:'区别于原讨论的新机制'})),c);
  await f.begin();await f.finish();assert.equal(f.remote.drafts.length,0);assert.ok(f.r.state.draft_request);
  const key=f.r.state.draft_request.key,write=f.r.write;let lost=true;
  f.r.write=async(...args)=>{const out=await write(...args);if(lost){lost=false;throw new Error('lost response');}return out;};
  await assert.rejects(flushDraftRequest(f.r));await flushDraftRequest(f.r);
  assert.equal(f.remote.drafts.length,1);assert.equal(f.remote.drafts[0].key,key);assert.equal(f.r.state.model_calls,2);
  assert.equal(f.remote.drafts[0].status,'pending');
  rememberResearchPublication(f.r,key,'post-published');assert.equal(new ResearchJournal(f.r.diary.directory).list()[0].post_id,'post-published');
});

test('same-topic follow-up queues a normal comment with normal website permission checks',async t=>{
  const f=fixture(t);f.r.researchPlanModel=async c=>parseResearchPlan(JSON.stringify(plan({related_post_id:'post-one'})),c);
  f.r.researchWriteModel=async c=>parseResearchDecision(JSON.stringify(decision({action:'reply',target_post_id:'post-one',body:'补充一个合作机制。'})),c);
  await f.begin();await f.finish();assert.equal(f.r.state.pending.kind,'comment');assert.equal(f.r.state.pending.manager_authorized,false);
  assert.equal(f.r.state.pending.payload.parent_id,null);assert.equal(f.r.state.draft_request,undefined);
  f.r.preferences.community.proactive_comments=false;assert.equal(f.r.pendingAllowed(f.r.state.pending),false);
});

test('a pending review prevents another draft, but allows a private research note',async t=>{
  const f=fixture(t);f.remote.drafts=[{id:'pending',status:'pending',content:{title:'PRIVATE_REJECTED_TITLE'}}];
  await f.begin();await f.finish();assert.equal(f.remote.model[1].can_post,false);
  assert.doesNotMatch(JSON.stringify(f.remote.model),/PRIVATE_REJECTED_TITLE/);assert.equal(f.r.state.research_last.outcome,'noted');
});

test('search failure is not retried or represented as having read sources',async t=>{
  const f=fixture(t);f.r.researchPlanModel=async c=>parseResearchPlan(JSON.stringify(plan({queries:['合作游戏']})),c);
  let count=0;f.r.researchWeb=async()=>{count++;throw new Error('offline');};
  await f.begin();await f.finish();assert.equal(count,1);
  assert.equal(f.remote.model.at(-1).search_status,'unavailable');assert.deepEqual(f.remote.model.at(-1).sources,[]);
});

test('completed plan survives an update; unfinished paid generation is not regenerated',async t=>{
  const f=fixture(t);await f.begin();f.r.state=structuredClone(f.r.state);await f.finish();assert.equal(f.r.state.model_calls,2);
  f.advance();await serviceResearch(f.r);const charged=f.r.state.model_calls;
  f.r.state.research_job.inflight='write';await serviceResearch(f.r);assert.equal(f.r.state.model_calls,charged);
  assert.equal(f.r.state.research_last.outcome,'interrupted');
});

test('paused host, game, quota and manual stop prevent new work',async t=>{
  const f=fixture(t);await serviceResearch(f.r);f.advance();
  f.r.preferences.community.paused=true;await serviceResearch(f.r);assert.equal(f.r.state.model_calls,0);
  f.r.preferences.community.paused=false;f.r.gameRuntime={busy:true};await serviceResearch(f.r);assert.equal(f.r.state.model_calls,0);
  f.r.gameRuntime.busy=false;f.r.limits.max_model_calls=0;await serviceResearch(f.r);assert.equal(f.r.state.model_calls,0);
  f.r.limits.max_model_calls=10;f.r.abort.abort();await serviceResearch(f.r);assert.equal(f.r.state.model_calls,0);
});

test('changing policy during generation saves the thought without sending a reply',async t=>{
  const f=fixture(t);f.r.researchPlanModel=async c=>plan({related_post_id:'post-one'});
  f.r.researchWriteModel=async()=>{f.r.preferences.community.proactive_comments=false;return decision({action:'reply',body:'一条补充',target_post_id:'post-one'});};
  await f.begin();await f.finish();assert.equal(f.r.state.pending,undefined);assert.equal(f.r.state.research_last.outcome,'noted_reply_disabled');
});

test('crash after durable handoff cannot queue the same completed output again',async t=>{
  const f=fixture(t);await f.begin();await serviceResearch(f.r);await serviceResearch(f.r);
  const j={...f.r.state.research_job,stage:'handoff',queued_outcome:'reply_queued',decision:decision({action:'reply',target_post_id:'post-one',body:'原回复'})};
  f.r.state.research_job=j;await serviceResearch(f.r);assert.equal(f.r.state.pending,undefined);
  assert.equal(f.r.state.research_last.outcome,'reply_queued');assert.equal(f.r.state.model_calls,2);
});

test('a deleted related post is unavailable to the writer and cannot be reconstituted from history',async t=>{
  const f=fixture(t);f.r.researchPlanModel=async c=>plan({related_post_id:'post-one'});
  const get=f.r.get;f.r.get=async path=>{if(path.includes('reading-context'))throw Object.assign(new Error(),{status:404});return get(path);};
  await f.begin();await f.finish();assert.deepEqual(f.remote.model.at(-1).posts,[]);assert.deepEqual(f.remote.model.at(-1).comments,[]);
});

test('full-text provenance and source URLs reach composition without invented citations',()=>{
  const c={can_reply:true,posts:[{id:'post-one'}],sources:[{url:'https://example.com/article',read_status:'read'}]};
  const v=decision({action:'reply',target_post_id:'post-one',body:'见 https://example.com/article',source_urls:['https://example.com/article']});
  assert.equal(parseResearchDecision(JSON.stringify(v),c).source_urls.length,1);
  assert.throws(()=>parseResearchDecision(JSON.stringify({...v,body:'见 https://evil.example/invented'}),c));
});

test('real DSH model adapter keeps 64000, selected reasoning and two-stage parsing through the final draft',async t=>{
  const f=fixture(t),configs=[];
  const context=()=>({agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture',reasoningEffort:'high'})},llm:{
    async prepareCall(config){configs.push(config);return {config,async *stream(){
      const output=configs.length===1 ? plan() : decision({action:'post',title:'合作实验',body:'尝试保留独立判断的合作机制。',new_question:'如何合作？',difference:'增加互相校验的机制'});
      yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}};
    }};}}});
  f.r.researchPlanModel=createRuntimeModel(context,{purpose:'research_plan',parse:parseResearchPlan});
  f.r.researchWriteModel=createRuntimeModel(context,{purpose:'research_write',parse:parseResearchDecision});
  await f.begin();await f.finish();assert.equal(configs.length,2);
  for(const c of configs){assert.equal(c.maxTokens,64000);assert.equal(c.reasoningEffort,'high');}
  await flushDraftRequest(f.r);assert.equal(f.remote.drafts[0].status,'pending');
  const view=readThoughtEntries([...f.r.diary.entries()],{identity:{actor_id:'ai-one',base_url:'https://community.example'},timezone:'Asia/Shanghai'});
  assert.equal(view.items[0].kind_label,'自主课题想法');
});

test('source correction during final async refresh prevents handoff; queued untouched output is cancelled too',async t=>{
  const f=fixture(t);f.seeds([{id:'seed-one',question:'如何设计游戏？',keywords:[]}]);
  f.r.researchWriteModel=async()=>decision({action:'post',title:'游戏的新发现',body:'公开观点',new_question:'新问题',difference:'新机制'});
  await f.begin();await serviceResearch(f.r);await serviceResearch(f.r);
  f.r.refreshPreferences=async()=>f.seeds([]);await serviceResearch(f.r);
  assert.equal(f.r.state.draft_request,undefined);assert.equal(f.r.state.research_last.outcome,'source_changed');
  f.r.state.draft_request={key:'saved-original',payload:{title:'未提交',body:'公开内容'},research_seed_ids:['seed-one']};
  await flushDraftRequest(f.r);assert.equal(f.r.state.draft_request,null);assert.equal(f.remote.drafts.length,0);
  f.r.state.draft_request={key:'attempted-original',payload:{title:'结果未知',body:'公开内容'},research_seed_ids:['seed-one'],attempted:true};
  await flushDraftRequest(f.r);assert.equal(f.remote.drafts.length,1);assert.equal(f.remote.drafts[0].key,'attempted-original');
});
