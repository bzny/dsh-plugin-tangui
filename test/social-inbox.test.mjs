import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CommunityRuntime} from '../lib/runtime.js';
import {SocialClient,validateSocial,inboxView} from '../lib/social-client.js';
import {validateRuntimeInput} from '../lib/runtime-tool.js';

const root = resolve('test-artifacts/social-inbox');
const reply = data => ({ok:true,status:200,json:async()=>({data})});
const rejected = (code,status=409) => ({ok:false,status,json:async()=>({error:{code}})});
function fixture(t) {
  const directory = join(root,randomUUID());mkdirSync(directory,{recursive:true});
  let binding = {baseUrl:'http://127.0.0.1:4999',actorId:'ai_test',token:'MOCK_ONLY',scopes:['posts:read','comments:write','events:read','dm:read','dm:write']};
  const remote = {calls:[],writes:[],accepted:new Map(),held:null,clock:2000000000000,lost:false,models:0,
    inbox:{actor_id:'ai_test',unread_count:2,friend_request_count:1,dm_request_count:1,unread_dm_count:1,
      friend_requests:[{id:'friend_test',actor:{id:'human_test',name:'胡安',kind:'human'}}],dm_requests:[{id:'dm_test',actor:{id:'human_test',name:'胡安',kind:'human'}}]}};
  const lease = () => ({actor_id:binding.actorId,active:true,owned_by_current_grant:true,epoch:3,server_time:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),renew_after_seconds:15});
  const fetchImpl = async(url,request) => {
    const path = new URL(url).pathname;remote.calls.push({path,method:request.method});
    const body = request.body && JSON.parse(request.body);
    if (remote.hook) { const result = await remote.hook(path,request); if (result) return result; }
    if (path === '/api/v1/agent/inbox') return reply(remote.inbox);
    if (path === '/api/v1/me') return reply({actor:{id:binding.actorId,kind:'ai',name:'AI'},scopes:binding.scopes});
    if (path === '/api/v1/capabilities') return reply({features:{}});
    if (path === '/api/v1/agent/control/acquire') {if(remote.held)return rejected('control_busy');remote.held=body.instance_id;return reply(lease());}
    if (path === '/api/v1/agent/control/release') {remote.held=null;return reply({active:false});}
    if (path === '/api/v1/conversations' && request.method === 'GET') return reply([]);
    if (path === '/api/v1/conversations/dm_test/messages' && request.method === 'POST') {
      assert.ok(remote.held);assert.equal(request.headers['X-AI-Instance-ID'],remote.held);
      const key = request.headers['Idempotency-Key'];remote.writes.push({key,body});
      if (!remote.accepted.has(key)) remote.accepted.set(key,{id:'message_test',conversation_id:'dm_test',body:body.body});
      if(remote.lost){remote.lost=false;throw new Error('response lost');}
      return reply(remote.accepted.get(key));
    }
    return rejected('not_found',404);
  };
  const make = () => new CommunityRuntime({directory,connection:{binding:()=>binding},fetchImpl,wallNow:()=>remote.clock,decide:async()=>{remote.models++;throw new Error('unexpected model');}});
  const runtime = make();
  t.after(async()=>{runtime.stop();await runtime.settled();assert.ok(resolve(directory).startsWith(root+'\\'));rmSync(directory,{recursive:true});});
  return {runtime,remote,make,binding,changeBinding:b=>{binding=b;}};
}

test('inbox works while stopped and budget exhausted; throttles without model calls or writes',async t=>{
  const f=fixture(t);f.runtime.commit({model_calls:999});
  const result = await f.runtime.refreshInbox();
  assert.equal(result.friend_request_count,1);assert.equal(result.friends_url,'http://127.0.0.1:4999/?social=friends');
  assert.equal(result.messages_url,'http://127.0.0.1:4999/messages?actor_id=ai_test');
  assert.deepEqual(result.friend_requests,f.remote.inbox.friend_requests,'old servers may omit account metadata');
  await f.runtime.refreshInbox();assert.equal(f.remote.calls.length,1);
  f.runtime.task=Promise.resolve();await f.runtime.refreshInbox(true);f.runtime.task=null;
  assert.equal(f.remote.calls.length,2);assert.equal(f.remote.models,0);assert.equal(f.remote.writes.length,0);
  assert.equal(f.runtime.state.model_calls,999);
});

test('shared friend metadata keeps only public fields and never pulls human private messages',async t=>{
  const f=fixture(t);
  const sender={id:'account_sender',type:'pair',name:'胡安 + 露娜',members:[
    {id:'human_test',name:'胡安',kind:'human',avatar_url:'/avatars/human.png',online:false},
    {id:'ai_sender',name:'露娜',kind:'ai',avatar_url:null,online:true},
  ]};
  const recipient={id:'account_self',type:'pair',name:'管理者 + AI',members:[
    {id:'human_self',name:'管理者',kind:'human'}, {id:'ai_test',name:'AI',kind:'ai'},
  ]};
  f.remote.inbox.friend_requests=[{id:'friend_test',actor:{id:'human_test',name:'胡安',kind:'human',email:'ACTOR_PRIVATE'},
    account:{...sender,email:'ACCOUNT_PRIVATE',manager:{name:'HIDDEN_MANAGER'},members:sender.members.map(member=>({...member,token:'MEMBER_PRIVATE'}))},
    recipient_account:{...recipient,dm_requests:['HUMAN_PRIVATE_REQUEST'],unread_dm_count:9},
    body:'HUMAN_PRIVATE_MESSAGE',recipient_id:'human_self'}];
  f.remote.inbox.human_dm_requests=[{id:'human_dm',body:'HUMAN_PRIVATE_MESSAGE'}];
  f.remote.inbox.dm_requests[0].account=sender;
  f.remote.inbox.dm_requests[0].recipient_account=recipient;
  f.remote.inbox.dm_requests[0].body='AI_PRIVATE_MESSAGE';
  const result=await f.runtime.refreshInbox();
  assert.deepEqual(result.friend_requests,[{id:'friend_test',actor:{id:'human_test',name:'胡安',kind:'human'},account:sender,recipient_account:recipient}]);
  assert.deepEqual(result.dm_requests,[{id:'dm_test',actor:{id:'human_test',name:'胡安',kind:'human'}}]);
  assert.equal(result.actor_id,'ai_test');assert.equal(result.dm_request_count,1);assert.equal(result.unread_dm_count,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|HIDDEN_MANAGER|human_dm_requests|recipient_id|email|token/);
  assert.deepEqual(f.remote.calls,[{path:'/api/v1/agent/inbox',method:'GET'}]);
  assert.equal(f.remote.models,0);assert.equal(f.remote.writes.length,0);
});

test('standalone public accounts do not expose a hidden manager and malformed groups fail explicitly',async t=>{
  const f=fixture(t);
  for(const kind of ['human','ai']) {
    const member={id:`${kind}_sender`,name:kind==='ai'?'独立伙伴':'人类朋友',kind};
    const account={id:`account_${kind}`,type:kind,name:member.name,members:[member]};
    const item={id:'friend_test',actor:member,account:{...account,manager:{id:'hidden',name:'HIDDEN_MANAGER'}}};
    const result=inboxView({...f.remote.inbox,friend_requests:[item]},f.binding,'now');
    assert.deepEqual(result.friend_requests[0].account,account);
    assert.doesNotMatch(JSON.stringify(result),/HIDDEN_MANAGER|manager/);
  }
  const solo={id:'account_ai',type:'ai',name:'独立伙伴',members:[{id:'ai_sender',name:'独立伙伴',kind:'ai'}]};
  for(const account of [
    {...solo,type:'private'}, {...solo,members:[...solo.members,{id:'hidden',name:'HIDDEN_MANAGER',kind:'human'}]},
    {...solo,members:[{...solo.members[0],online:'yes'}]},
    {...solo,members:[{...solo.members[0],avatar_url:{email:'PRIVATE'}}]},
  ]) assert.throws(()=>inboxView({...f.remote.inbox,friend_requests:[{id:'friend_test',actor:solo.members[0],account}]},f.binding,'now'),{code:'invalid_inbox_response'});
});

test('new identity discards a delayed inbox response and clears stale reminders',async t=>{
  const f=fixture(t);let release;f.remote.hook=()=>new Promise(r=>{release=r;});
  const work=f.runtime.refreshInbox();
  f.changeBinding({...f.binding,actorId:'ai_other'});
  assert.equal(f.runtime.publicStatus().inbox,null);
  release(reply(f.remote.inbox));await work;
  assert.equal(f.runtime.publicStatus().inbox,null);
});

test('inbox failures retain last successful checked time with an explicit error',async t=>{
  const f=fixture(t);await f.runtime.refreshInbox();const at=f.runtime.publicStatus().inbox.checked_at;
  f.remote.hook=()=>rejected('scope_denied',403);await f.runtime.refreshInbox(true);
  assert.equal(f.runtime.publicStatus().inbox.checked_at,at);assert.ok(f.runtime.publicStatus().inbox.error);
});

test('queued receipt refresh confirms published author and post without resubmission',async t=>{
  const f=fixture(t);f.runtime.commit({last_submission:{id:'comment_test',kind:'comment',post_id:'post_test',status:'queued'}});
  f.remote.hook=path=>path==='/api/v1/comments/comment_test'?reply({id:'comment_test',post_id:'post_test',author:{id:'ai_test'},status:'published',published_at:'2033-05-18T03:33:20Z'}):null;
  await f.runtime.refreshPublication();
  assert.equal(f.runtime.publicStatus().last_submission.status,'published');
  assert.equal(JSON.parse(readFileSync(f.runtime.stateFile,'utf8')).last_submission.status,'published');
  assert.equal(f.remote.models,0);assert.ok(f.remote.calls.every(c=>c.method==='GET'));
});

test('missing, wrong-author or superseded receipts never become published',async t=>{
  const f=fixture(t);const original={id:'comment_test',kind:'comment',post_id:'post_test',status:'queued'};f.runtime.commit({last_submission:original});
  await f.runtime.refreshPublication();assert.equal(f.runtime.state.last_submission.status,'queued');
  f.remote.clock+=15000;f.remote.hook=()=>reply({id:'comment_test',post_id:'post_test',author:{id:'other'},status:'published'});
  await f.runtime.refreshPublication();assert.equal(f.runtime.state.last_submission.status,'queued');
  f.remote.clock+=15000;let release;f.remote.hook=()=>new Promise(r=>{release=r;});
  const work=f.runtime.refreshPublication();f.runtime.commit({last_submission:{...original,id:'comment_new'}});
  release(reply({id:'comment_test',post_id:'post_test',author:{id:'ai_test'},status:'published'}));await work;
  assert.equal(f.runtime.state.last_submission.id,'comment_new');assert.equal(f.runtime.state.last_submission.status,'queued');
});

test('DM writes reuse one controller and durable original request after restart',async t=>{
  const f=fixture(t);const args={action:'dm_send',conversation_id:'dm_test',body:'私密回复'};
  f.remote.held='other';await assert.rejects(()=>f.runtime.engagement(args),{code:'control_busy'});assert.equal(f.remote.writes.length,0);
  f.remote.held=null;f.remote.lost=true;await assert.rejects(()=>f.runtime.engagement(args),{code:'network_error'});
  const key=f.runtime.state.pending_engagement.key;const restarted=f.make();
  await assert.rejects(()=>restarted.engagement({...args,body:'changed'}),{code:'engagement_pending'});
  const result=await restarted.engagement({action:'retry_engagement'});
  assert.equal(result.result.body,args.body);assert.equal(f.remote.accepted.size,1);
  assert.ok(f.remote.writes.every(w=>w.key===key));assert.equal(f.remote.models,0);
  assert.equal(restarted.state.pending_engagement,null);
});

test('DM reads need no controller and input validation cannot inject a path or oversized body',async t=>{
  const f=fixture(t);f.remote.held='other';await f.runtime.engagement({action:'dm_conversations'});
  assert.equal(f.remote.held,'other');assert.equal(f.remote.writes.length,0);
  for (const args of [{action:'dm_send',conversation_id:'../bad',body:'hi'},{action:'dm_send',conversation_id:'dm_test',body:'x'.repeat(2001)},{action:'dm_accept',conversation_id:'dm_test',manage:true}]) assert.throws(()=>validateRuntimeInput(args));
  assert.deepEqual(validateSocial({action:'dm_messages',conversation_id:'dm_test'}),{action:'dm_messages',conversation_id:'dm_test',cursor:'0',limit:50});
  assert.throws(()=>inboxView({...f.remote.inbox,actor_id:'other'},f.binding,'now'));
  const client=new SocialClient({request:async()=>({data:[{conversation_id:'other',body:'private'}]})});
  await assert.rejects(()=>client.execute({action:'dm_messages',conversation_id:'dm_test'}),{code:'invalid_social_response'});
});
