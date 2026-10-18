import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const DEFAULT_ASK_TIMEOUT_MS=20*60*1000
export function askTimeout(value=DEFAULT_ASK_TIMEOUT_MS){
 const ms=Number(value)
 if(!Number.isInteger(ms)||ms<1000||ms>60*60*1000)throw Error('timeout-ms must be 1000..3600000')
 return ms
}
export function writeJob(path,job){
 mkdirSync(dirname(path),{recursive:true,mode:0o700})
 const temp=path+'.'+randomUUID()+'.tmp'
 writeFileSync(temp,JSON.stringify(job,null,1)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path)
}
export function newJob(root,{identity,question,model,timeoutMs}){
 const id=randomUUID(),now=new Date().toISOString()
 const job={schema:'chatgpt-native-job/v1',id,phase:'prepared',identity,question,model,timeoutMs,startedAt:now,updatedAt:now,submitted:false,retryAutomatically:false}
 return {path:join(root,'native-jobs',id+'.json'),job}
}
export function recoverCompletedAnswer(raw,job,identity){
 if(typeof identity?.email!=='string'||!identity.email||identity.remoteVerified!==true||job.identity?.accountId!==identity.accountId||job.identity?.userId!==identity.userId)throw Error('Recovery identity mismatch')
 if((raw.conversation_id??raw.id)!==job.conversationId||raw.is_temporary_chat!==true)throw Error('Recovery target is not the verified temporary conversation')
 const messages=[],seen=new Set();let node=raw.current_node
 while(node&&raw.mapping?.[node]&&!seen.has(node)){
  seen.add(node);if(raw.mapping[node].message)messages.push(raw.mapping[node].message)
  node=raw.mapping[node].parent
 }
 messages.reverse()
 const text=m=>(m.content?.parts??[]).filter(p=>typeof p==='string').join('\n\n')
 const userIndex=messages.findIndex(m=>m.author?.role==='user'&&text(m).trim()===job.question.trim()&&(!job.userMessageId||m.id===job.userMessageId))
 if(userIndex<0)throw Error('Recovery question not found in the current branch; no answer accepted')
 const after=messages.slice(userIndex+1)
 if(after.some(m=>m.author?.role==='user'))throw Error('Recovery branch contains a later question')
 const complete=after.filter(m=>m.author?.role==='assistant'&&m.recipient==='all'&&[null,undefined,'final'].includes(m.channel)&&m.status==='finished_successfully'&&m.end_turn===true&&m.content?.content_type==='text')
 const answer=complete.map(text).filter(Boolean).join('\n\n')
 if(!answer)return null
 return {ok:true,identity,question:job.question,conversationId:job.conversationId,answer,assistantMessages:complete,
  streamDone:false,completionVerifiedBy:'remote-current-branch',temporaryRequested:true,
  temporaryVerification:{serverTemporaryFlag:true,recoveredWithoutResend:true},
  searchEvidence:{tool_invoked:complete.some(m=>m.metadata?.search_result_groups?.length>0)}}
}
