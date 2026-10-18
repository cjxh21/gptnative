import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askTimeout, DEFAULT_ASK_TIMEOUT_MS, newJob, writeJob, recoverCompletedAnswer } from '../native-jobs.mjs'
const identity={email:'user@example.com',accountId:'account-A',userId:'user-A',remoteVerified:true}
const job={identity,conversationId:'00000000-0000-4000-8000-000000000001',question:'original question',userMessageId:'user-message'}
const raw=()=>({conversation_id:job.conversationId,is_temporary_chat:true,current_node:'a',mapping:{
 u:{parent:null,message:{id:'user-message',author:{role:'user'},content:{content_type:'text',parts:['original question']}}},
 a:{parent:'u',message:{id:'answer',author:{role:'assistant'},recipient:'all',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['completed answer']}}}}})
test('long timeout defaults to 20 minutes and has explicit bounds',()=>{
 assert.equal(askTimeout(),DEFAULT_ASK_TIMEOUT_MS);assert.equal(askTimeout(1800000),1800000)
 assert.throws(()=>askTimeout(0));assert.throws(()=>askTimeout(3600001))
})
test('job checkpoint atomically retains prompt, partial answer and conversation id privately',()=>{
 const root=mkdtempSync(join(tmpdir(),'acw-job-'))
 try{const {path,job:j}=newJob(root,{identity,question:'q',model:'gpt-6',timeoutMs:1200000});writeJob(path,{...j,phase:'streaming',conversationId:job.conversationId,partialAnswer:'partial'})
  assert.equal(JSON.parse(readFileSync(path)).partialAnswer,'partial');assert.equal(statSync(path).mode&0o777,0o600)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('recovery accepts only a positive completed answer for the original question',()=>{
 const r=recoverCompletedAnswer(raw(),job,identity);assert.equal(r.answer,'completed answer');assert.equal(r.streamDone,false);assert.equal(r.completionVerifiedBy,'remote-current-branch')
 const pending=raw();pending.mapping.a.message.end_turn=false;assert.equal(recoverCompletedAnswer(pending,job,identity),null)
})
test('recovery refuses account, conversation, branch and question mismatches',()=>{
 assert.throws(()=>recoverCompletedAnswer(raw(),job,{...identity,accountId:'other'}))
 const changed=raw();changed.conversation_id='other';assert.throws(()=>recoverCompletedAnswer(changed,job,identity))
 assert.throws(()=>recoverCompletedAnswer(raw(),{...job,question:'another question'},identity))
 const later=raw();later.mapping.v={parent:'a',message:{id:'later',author:{role:'user'},content:{parts:['later question']}}};later.current_node='v'
 assert.throws(()=>recoverCompletedAnswer(later,job,identity))
})
