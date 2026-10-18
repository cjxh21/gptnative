/** Completed, account-verified ordinary temporary ChatGPT answers, saved locally. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireLease } from './runtime.mjs'
import { libraryRoot, readJson } from './local-library.mjs'

export const NATIVE_ANSWER_SCHEMA='chatgpt-native-temporary/v1'
export function normalizeNativeAnswer(raw){
 return [`# ${raw.title}`, '', `- id: ${raw.conversationId}`, '- 来源: 固定账号 ChatGPT 普通临时会话',
  '- 导出范围: 本地提交的问题及完成回答；不包含完整远端消息树或附件文件。', '',
  '## 我','',raw.question,'','## ChatGPT','',raw.answer,''].join('\n')
}
function atomic(path,value){const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path)}
// Control tokens can occur inside stream metadata. Never persist them even if a
// future transport accidentally passes through an unsanitized message.
function withoutTokens(value){
 if(Array.isArray(value))return value.map(withoutTokens)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([k,v])=>!(typeof v==='string'&&/^(authorization|token|access_token|refresh_token|id_token|.*_resume_token|.*_conversation_token)$/i.test(k)))
  .map(([k,v])=>[k,withoutTokens(v)]))
 return value
}
export async function archiveNativeAnswer(result,{root=libraryRoot()}={}){
 if(result?.ok!==true||(result.streamDone!==true&&result.completionVerifiedBy!=='remote-current-branch')||result.temporaryRequested!==true||!result.answer?.trim()||!result.question?.trim())throw Error('Only a completed ordinary temporary answer can be archived')
 // 归档前要求身份完整且已验证；具体是哪个账号由调用方配置决定，此处不写死
 if(typeof result.identity?.email!=='string'||!result.identity.email||result.identity.remoteVerified!==true||!result.identity.accountId||!result.identity.userId)throw Error('Pinned account identity is not verified')
 if(!/^[0-9a-f-]{36}$/i.test(result.conversationId))throw Error('Invalid native conversation id')
 const lease=await acquireLease('websync',{timeoutMs:10000});if(!lease)throw Error('Local library busy; keep the answer and retry archive only, never resend')
 try{
  for(const d of [root,join(root,'raw'),join(root,'normalized'),join(root,'agent')])mkdirSync(d,{recursive:true,mode:0o700})
  const indexPath=join(root,'index.json'),index=readJson(indexPath,{conversations:{},counts:{}})
  if(!index.conversations||typeof index.conversations!=='object'||Array.isArray(index.conversations))throw Error('Invalid existing library index; refusing overwrite')
  const id='native-temp-'+result.conversationId,prior=index.conversations[id]
  if(prior?.source_account_id&&prior.source_account_id!==result.identity.accountId)throw Error('Native archive account changed')
  const now=new Date().toISOString(),title=result.question.trim().slice(0,60)
  const raw={schema:NATIVE_ANSWER_SCHEMA,title,conversationId:result.conversationId,identity:result.identity,
   question:result.question,answer:result.answer,assistantMessages:withoutTokens(result.assistantMessages??[]),
   searchEvidence:result.searchEvidence??{},temporaryVerification:result.temporaryVerification??null,
   completionVerifiedBy:result.completionVerifiedBy??'completed-event-stream',
   coverage:{rawTreeAvailable:false,attachmentFilesExported:false},savedAt:now,
   _dsh_source:{origin:'chatgpt-native',email:result.identity.email,accountId:result.identity.accountId}}
  const rawPath=join(root,'raw',id+'.json'),mdPath=join(root,'normalized',id+'.md')
  atomic(rawPath,raw);atomic(mdPath,normalizeNativeAnswer(raw))
  index.conversations[id]={title,create_time:prior?.create_time??now,update_time:now,deleted:false,origin:'chatgpt-native',
   source_account_id:result.identity.accountId,source_account_email:result.identity.email,source_id:result.conversationId,format:NATIVE_ANSWER_SCHEMA,synced_at:now}
  index.counts={...index.counts,local:Object.keys(index.conversations).length};atomic(indexPath,index)
  const journal=join(root,'agent',now.slice(0,10)+'.jsonl'),recordId='chatgpt-native:'+result.conversationId
  const duplicate=existsSync(journal)&&readFileSync(journal,'utf8').split('\n').some(l=>{try{return JSON.parse(l).recordId===recordId}catch{return false}})
  if(!duplicate)appendFileSync(journal,JSON.stringify({ts:now,recordId,origin:'native-agent',conversationId:result.conversationId,
   account:result.identity.email,sessionPolicy:'temporary',ok:true,question:result.question,answer:result.answer,sources:result.sources??[]})+'\n',{mode:0o600})
  return{ok:true,id,raw:rawPath,md:mdPath}
 }finally{lease.release()}
}
