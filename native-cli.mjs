#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { acquireLease } from './lib/runtime.mjs'
import { normalizeConversation } from './lib/normalize.mjs'
import { readJson } from './lib/storage.mjs'
import { archiveNativeAnswer } from './lib/native-library.mjs'
import { askTimeout, newJob, writeJob, recoverCompletedAnswer } from './native-jobs.mjs'
import { runSetup, runDoctor, setupHelpText } from './lib/setup.mjs'
import { loadValidatedConfig, profileSettings, listProfiles } from './lib/config.mjs'
import { accountsRoot, listAccounts, readCredential as readStoreCredential } from './lib/accounts-store.mjs'
import { ensureFreshCredential } from './lib/token-refresh.mjs'
import { describeCredential } from './lib/accounts-store.mjs'

const here=dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2)
const opt=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1]}
const command=args[0]
const CLI_VERSION='1.0.0'
// --version is documented metadata, not a dispatched command: answer it before
// the command allowlist so it cannot surface as "Unknown command".
if(args.includes('--version')||args.includes('-v')){
 console.log(`gptnative ${CLI_VERSION}`);process.exit(0)
}
if(!command||args.includes('--help')){
 console.log(`ChatGPT native HTTP CLI; no browser or Codex model turns.
  gptnative login [--profile NAME] [--library DIR]   # 浏览器验证码登录并导入凭据
  gptnative setup --auth FILE [--library DIR] [--profile NAME]
  gptnative doctor
  gptnative profiles
  gptnative account
  gptnative models
  gptnative list [--archived] [--limit 20]
  gptnative requirements-probe
  gptnative device-probe
  gptnative backup [--root DIR] [--budget N] [--full]
  gptnative archive --input COMPLETED_RESULT.json [--root DIR]
  gptnative ask --temporary --prompt-file QUESTION.txt [--model SLUG] [--search]
  Add --async to return a durable job immediately, independent of caller timeout.
  gptnative status --job JOB.json [--content]
  gptnative recover --job JOB.json [--timeout-ms 1200000]
  Ask timeout defaults to 20 minutes; --timeout-ms accepts 1000..3600000.
  --output RESULT.json saves a private JSON result.
  gptnative --version
Credentials come from ~/.gptaccounts (run "gptnative setup" first; "gptnative doctor" checks it).
Backup preserves full raw message trees and existing library entries; no remote writes.
Ask is experimental; uncertain sends are never retried.`);process.exit(0)
}
// setup / doctor 必须在凭据校验之前处理：它们本身就是用来建立凭据的。
if(command==='setup'){
 try{
  const result=runSetup({authFile:opt('--auth'),library:opt('--library'),profileName:opt('--profile')??'default',
   root:accountsRoot(),configFile:opt('--config'),force:args.includes('--force')})
  console.log(JSON.stringify(result))
 }catch(error){
  console.error(JSON.stringify({ok:false,code:error.code??error.message,detail:error.detail??null}))
  if(error.code==='AUTH_FILE_REQUIRED'||error.code==='AUTH_FILE_NOT_FOUND')console.error(setupHelpText())
  process.exitCode=1
 }
 process.exit()
}
if(command==='doctor'){
 const report=runDoctor({root:accountsRoot(),configFile:opt('--config')})
 console.log(JSON.stringify(report))
 process.exit(report.configured?0:2)
}
// login：在其他设备上一键完成 codex 登录并导入凭据
if(command==='login'){
 const { loginAndImport } = await import('./lib/login.mjs')
 try{
  const result=await loginAndImport({
   codexBin:opt('--codex')??'codex',
   profileName:opt('--profile')??'default',
   library:opt('--library'),
   root:accountsRoot(),
   onPrompt:({verificationUrl,userCode})=>{
    // 面向人而不是机器：这两行是给用户照着操作的
    console.error('')
    console.error('请在浏览器打开：'+verificationUrl)
    console.error('输入一次性验证码：'+userCode)
    console.error('（验证码 15 分钟内有效；请确认是你本人在发起登录）')
    console.error('')
   }
  })
  console.log(JSON.stringify(result))
 }catch(error){
  console.error(JSON.stringify({ok:false,code:error.code??error.message,detail:error.detail??null}))
  process.exitCode=1
 }
 process.exit()
}
if(command==='profiles'){
 const loaded=loadValidatedConfig({configFile:opt('--config')})
 if(!loaded.ok){console.error(JSON.stringify({ok:false,code:loaded.code,path:loaded.path}));process.exitCode=1;process.exit()}
 console.log(JSON.stringify({ok:true,activeProfile:loaded.config.activeProfile,profiles:listProfiles(loaded.config)}))
 process.exit()
}
// 解析本次使用的账号与凭据（--profile 优先，其次配置 activeProfile）
function authContext(){
 const loaded=loadValidatedConfig({})
 if(!loaded.ok)throw Object.assign(Error('NOT_CONFIGURED'),{code:'NOT_CONFIGURED',detail:loaded.code})
 const name=opt('--profile')??loaded.config.activeProfile
 const settings=profileSettings(loaded.config,name)
 process.env.GPTNATIVE_PROFILE=name
 const credential=readCredentialFor(settings.account)
 if(!credential)throw Object.assign(Error('CREDENTIAL_NOT_FOUND'),{code:'CREDENTIAL_NOT_FOUND',email:settings.account})
 return {email:settings.account,profile:name,settings,credential}
}
function readCredentialFor(email){return readStoreCredential(email,accountsRoot())}
// 库目录优先级：--root > WEBSYNC_DIR > profile.library > 历史默认值。
// 跟随 profile 才能让多库配置真正生效。
function resolveLibraryRoot(){
 const explicit=opt('--root')??process.env.WEBSYNC_DIR
 if(explicit)return explicit
 try{
  const loaded=loadValidatedConfig({})
  if(loaded.ok){
   const name=opt('--profile')??loaded.config.activeProfile
   return profileSettings(loaded.config,name).library
  }
 }catch{}
 return join(homedir(),'Documents/ChatGPT','websync')
}
const root=resolveLibraryRoot()
const timeoutMs=askTimeout(opt('--timeout-ms'))
let job=null,jobPath=null,lastNotice=0
function updateJob(patch){if(job&&jobPath){job={...job,...patch,updatedAt:new Date().toISOString()};writeJob(jobPath,job)}}
if(command==='status'){
 const path=opt('--job'),saved=JSON.parse(readFileSync(path,'utf8'))
 if(saved.schema!=='chatgpt-native-job/v1')throw Error('Invalid native job')
 const status={ok:true,job:path,phase:saved.phase,submitted:saved.submitted,updatedAt:saved.updatedAt,
  conversationId:saved.conversationId,answerChars:saved.result?.answer?.length??saved.partialAnswer?.length??0,
  complete:saved.phase==='done',error:saved.error,resultFile:saved.resultFile,archive:saved.result?.archive}
 if(args.includes('--content'))status.content=saved.result??{partialAnswer:saved.partialAnswer,complete:false}
 console.log(JSON.stringify(status));process.exit(0)
}
if(command==='ask'&&args.includes('--async')){
 if(!args.includes('--temporary'))throw Error('Explicit --temporary is required')
 try{const selected=authContext();process.env.GPTNATIVE_EXPECTED_EMAIL=selected.email}
 catch(error){console.error(JSON.stringify({ok:false,code:error.code??error.message,submitted:false}));process.exit(1)}
 const prompt=readFileSync(opt('--prompt-file'),'utf8')
 if(!prompt.trim()||[...prompt].length>100000)throw Error('Invalid prompt')
 const created=newJob(root,{identity:{email:process.env.GPTNATIVE_EXPECTED_EMAIL??null},question:prompt,model:opt('--model'),timeoutMs})
 const output=opt('--output')??created.path+'.result.json',logPath=created.path+'.log'
 const queued={...created.job,phase:'queued',resultFile:output};writeJob(created.path,queued)
 const workerArgs=args.filter(a=>a!=='--async');if(!opt('--output'))workerArgs.push('--output',output)
 if(!opt('--root')&&!process.env.WEBSYNC_DIR)workerArgs.push('--root',root)
 workerArgs.push('--job-file',created.path)
 const log=openSync(logPath,'a',0o600)
 try{
  const worker=spawn(process.execPath,[fileURLToPath(import.meta.url),...workerArgs],{cwd:process.cwd(),env:process.env,detached:true,stdio:['ignore',log,log]})
  await new Promise((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject)})
  worker.unref();console.log(JSON.stringify({ok:true,phase:'queued',job:created.path,resultFile:output,submitted:false}))
 }catch{
  writeJob(created.path,{...queued,phase:'failed',error:{code:'BACKGROUND_WORKER_START_FAILED'}})
  console.error(JSON.stringify({ok:false,code:'BACKGROUND_WORKER_START_FAILED',job:created.path,submitted:false}));process.exitCode=1
 }finally{closeSync(log)}
 // A worker owns the model request. Ending this caller does not terminate it.
 process.exit()
}
if(opt('--job-file')){
 jobPath=opt('--job-file');job=JSON.parse(readFileSync(jobPath,'utf8'))
 if(job.schema!=='chatgpt-native-job/v1'||job.phase!=='queued')throw Error('Background job is not queued; refusing to send')
 updateJob({phase:'initializing'})
}
if(command==='archive'){
 try{const saved=JSON.parse(readFileSync(opt('--input'),'utf8'));console.log(JSON.stringify(await archiveNativeAnswer(saved.result??saved,{root})))}
 catch(error){console.error(JSON.stringify({ok:false,code:error.message,retryAutomatically:false}));process.exitCode=1}
 process.exit()
}
if(!['account','models','list','projects','inspect-chat','backup','ask','recover','requirements-probe','device-probe','conversation-preflight'].includes(command))throw Error('Unknown command')
if(command==='ask'&&!args.includes('--temporary'))throw Error('Explicit --temporary is required')
// 凭据来自 ~/.gptaccounts 共享库；临近过期时自动刷新并写回（方案 B）。
// 绝不回退到桌面/其他账号的凭据。
try {
 const selected=authContext()
 const state=await ensureFreshCredential(selected.email,selected.credential,{root:accountsRoot()})
 if(state.refreshed)console.error(JSON.stringify({phase:'credential-refreshed',email:selected.email}))
 process.env.GPTNATIVE_EXPECTED_EMAIL=selected.email
}catch(error){updateJob({phase:'failed',error:{code:error.code??error.message},submitted:false});console.error(JSON.stringify({ok:false,code:error.code??error.message,detail:error.detail,submitted:false,retryAutomatically:false}));process.exit(1)}
const child=spawn('uv',['run','--no-project','--with','curl-cffi==0.16.3','python',join(here,'native-http.py')],
 {cwd:here,env:{...process.env,UV_CACHE_DIR:'/tmp/gptweb-native-uv-cache'},stdio:['pipe','pipe','pipe'],detached:true})
const stopChild=()=>{try{process.kill(-child.pid,'SIGTERM')}catch{child.kill()}}
let seq=0,readyResolve,readyReject,stderrBytes=0
const pending=new Map(),ready=new Promise((r,j)=>{readyResolve=r;readyReject=j})
child.stderr.on('data',x=>{stderrBytes+=x.length})
const abort=()=>{const e=Error('Native HTTP transport exited');readyReject(e);for(const p of pending.values())p.reject(e);pending.clear()}
child.on('error',abort);child.on('exit',abort)
createInterface({input:child.stdout}).on('line',line=>{
 let m;try{m=JSON.parse(line)}catch{return}
 if(m.event==='progress'){
  updateJob({...m.data,submitted:'unknown'})
  if(Date.now()-lastNotice>=15000){console.error(JSON.stringify({phase:m.data.phase,job:jobPath,elapsedMs:m.data.elapsedMs,answerChars:m.data.partialAnswer?.length??0}));lastNotice=Date.now()}
  return
 }
 if('ready'in m){m.ready?readyResolve(m.identity):readyReject(Object.assign(Error(m.error.code),m.error));return}
 const p=pending.get(m.id);if(!p)return;pending.delete(m.id)
 m.error?p.reject(Object.assign(Error(m.error.code),m.error)):p.resolve(m.result)
})
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')})
const get=path=>rpc('get',{path})
function atomic(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path)}
const read=(path,fallback)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):fallback
let lease,timer
let sendAttempted=false
const interrupted=code=>{updateJob({phase:'interrupted',submitted:sendAttempted?'unknown':false,retryAutomatically:false});lease?.release();stopChild();process.exit(code)}
process.once('SIGTERM',()=>interrupted(143))
process.once('SIGINT',()=>interrupted(130))
try{
 timer=setTimeout(()=>{updateJob({phase:'timeout',submitted:sendAttempted?'unknown':false,retryAutomatically:false});console.error(JSON.stringify({ok:false,code:'CLI_TIMEOUT',job:jobPath,submitted:sendAttempted?'unknown':false,retryAutomatically:false}));lease?.release();stopChild();process.exit(1)},command==='backup'?45*60000:['ask','recover'].includes(command)?timeoutMs+120000:210000)
 const identity=await ready
 // 身份必须与配置期望一致且经远端核验，不回退其他账号
 const expected=process.env.GPTNATIVE_EXPECTED_EMAIL
 if(!expected||identity.email!==expected||identity.remoteVerified!==true)throw Error('Pinned identity not verified')
 let result={ok:true,identity}
 if(command==='models')result.catalog=await get('/models')
 if(command==='requirements-probe')result.requirements=await rpc('requirements-probe',{})
 if(command==='device-probe')result.device=await rpc('device-probe',{})
 if(command==='conversation-preflight')result.preflight=await rpc('conversation-preflight',{})
 if(command==='list')result.page=await get('/conversations?'+new URLSearchParams({offset:'0',limit:String(Number(opt('--limit')??20)),order:'updated',is_archived:String(args.includes('--archived'))}))
 if(command==='projects')result.page=await get('/gizmos/snorlax/sidebar?'+new URLSearchParams({conversations_per_gizmo:'0',limit:'20',owned_only:'true'}))
 if(command==='inspect-chat'){
  try{const raw=await get('/conversation/'+opt('--thread'));result.chat={id:raw.conversation_id??raw.id,isTemporaryChat:raw.is_temporary_chat,historyDisabled:raw.history_and_training_disabled,keys:Object.keys(raw)}}
  catch(error){result.chat={httpStatus:error.httpStatus,code:error.code};if(error.httpStatus!==404)throw error}
 }
 if(command==='backup'){
  const budget=Number(opt('--budget')??0);if(!Number.isInteger(budget)||budget<0)throw Error('Invalid backup budget')
  lease=await acquireLease('websync',{timeoutMs:10000});if(!lease)throw Error('Existing local library is busy')
  const indexPath=join(root,'index.json'),index=read(indexPath,{conversations:{},counts:{},lastSync:null})
  if(!index.conversations||Array.isArray(index.conversations))throw Error('Invalid existing index; refusing overwrite')
  const list=new Map(),listingProof=[]
  for(const archived of [false,true]){
   let complete=false,pages=0
   for(let offset=0;offset<20000;offset+=100){
    const page=await get('/conversations?'+new URLSearchParams({offset:String(offset),limit:'100',order:'updated',is_archived:String(archived)}));pages++
    if(!Array.isArray(page.items))throw Error('Invalid listing; refusing deletion reconciliation')
    if(page.items.length===0){complete=true;break}
    let added=0;for(const c of page.items){if(!list.has(c.id))added++;list.set(c.id,{...c,is_archived:archived})}
    if(added===0)throw Error('Listing pagination made no progress')
    console.error(JSON.stringify({phase:'listing',archived,listed:list.size}))
   }
   listingProof.push({archived,pages,complete})
   if(!complete)throw Error('Listing page cap reached; backup incomplete')
  }
  const projects=[],projectCursors=new Set();let projectCursor=null
  do{
   const query=new URLSearchParams({conversations_per_gizmo:'0',limit:'20',owned_only:'true'});if(projectCursor)query.set('cursor',projectCursor)
   const page=await get('/gizmos/snorlax/sidebar?'+query)
   if(!Array.isArray(page.items))throw Error('Invalid project listing')
   for(const item of page.items){
    const id=item.gizmo?.gizmo?.id??item.gizmo?.id
    if(typeof id!=='string')throw Error('Project identity missing; refusing incomplete backup')
    projects.push(id)
   }
   projectCursor=page.cursor
   if(projectCursor){if(projectCursors.has(projectCursor)||projectCursors.size>=100)throw Error('Project cursor did not advance');projectCursors.add(projectCursor)}
  }while(projectCursor)
  for(const id of new Set(projects)){
   if(!/^[\w-]{1,100}$/.test(id))throw Error('Invalid project id')
   let cursor=null;const cursors=new Set()
   do{
    const query=new URLSearchParams({limit:'20',owned_only:'true'});if(cursor)query.set('cursor',cursor)
    const page=await get('/gizmos/'+id+'/conversations?'+query)
    if(!Array.isArray(page.items))throw Error('Invalid project conversation listing')
    for(const c of page.items)list.set(c.id,{...c,is_archived:list.get(c.id)?.is_archived??c.is_archived??false})
    cursor=page.cursor
    if(cursor){if(cursors.has(cursor)||cursors.size>=200)throw Error('Project conversation cursor did not advance');cursors.add(cursor)}
   }while(cursor)
   console.error(JSON.stringify({phase:'project-listing',projects:projects.length,listed:list.size}))
   await new Promise(r=>setTimeout(r,500))
  }
  listingProof.push({ownedProjects:new Set(projects).size,complete:true})
  let saved=0,skipped=0,reusedUnchanged=0,attempted=0,readRateLimitWaits=0;const failures=[]
  for(const c of list.values()){
   if(!/^[0-9a-f-]{36}$/i.test(c.id))throw Error('Invalid remote conversation id')
   const prior=index.conversations[c.id],rawPath=join(root,'raw',c.id+'.json'),mdPath=join(root,'normalized',c.id+'.md')
   if(prior?.source_account_id&&prior.source_account_id!==identity.accountId)throw Error('Existing conversation belongs to a different pinned account')
   if(!args.includes('--full')&&prior?.origin==='chatgpt-native'&&String(prior.update_time)===String(c.update_time)&&existsSync(rawPath)&&existsSync(mdPath)){skipped++;continue}
   // The user's original browser export is already a valid backup. If the
   // authenticated remote listing confirms the same id and revision, retain
   // its exact bytes instead of redownloading every unchanged old conversation.
   if(!args.includes('--full')&&prior&&!prior.origin&&String(prior.update_time)===String(c.update_time)&&existsSync(rawPath)&&existsSync(mdPath)){
    const oldRaw=read(rawPath,null)
    if((oldRaw?.conversation_id??oldRaw?.id)===c.id&&oldRaw.mapping&&oldRaw.current_node){
     index.conversations[c.id]={...prior,is_archived:c.is_archived,deleted:false,origin:'chatgpt-native',
      source_account_id:identity.accountId,source_account_email:identity.email,
      source_verified_by:'authenticated-list-same-id-and-update-time',verified_at:new Date().toISOString()}
     reusedUnchanged++;continue
    }
   }
   if(budget&&attempted>=budget)break
   attempted++
   try{
    let raw
    for(let attempt=0;attempt<4;attempt++){
     try{raw=await get('/conversation/'+c.id);break}
     catch(error){
      if(error.httpStatus!==429||attempt===3)throw error
      const cooldown=Math.max(65,Math.min(300,error.retryAfterSeconds??65));readRateLimitWaits++
      console.error(JSON.stringify({phase:'read-rate-limit-cooldown',seconds:cooldown,saved,skipped,reusedUnchanged,listed:list.size}))
      await new Promise(r=>setTimeout(r,cooldown*1000))
     }
    }
    if((raw.conversation_id??raw.id)!==c.id||!raw.mapping||!raw.current_node)throw Error('Incomplete raw conversation response')
    raw._dsh_source={origin:'chatgpt-native',email:identity.email,accountId:identity.accountId,userId:identity.userId,verifiedAt:new Date().toISOString()}
    atomic(rawPath,raw);atomic(mdPath,normalizeConversation(raw))
    index.conversations[c.id]={...prior,title:raw.title??c.title??'',create_time:c.create_time??raw.create_time,update_time:c.update_time??raw.update_time,
     is_archived:c.is_archived,deleted:false,origin:'chatgpt-native',source_account_id:identity.accountId,source_account_email:identity.email,synced_at:new Date().toISOString()}
    index.counts={...index.counts,local:Object.keys(index.conversations).length};index.lastNativeHttpSync=new Date().toISOString();atomic(indexPath,index);saved++
   }catch(e){failures.push({id:c.id,code:e.code??e.message,httpStatus:e.httpStatus,retryAfterSeconds:e.retryAfterSeconds});if(e.httpStatus!==404)break}
   if(attempted%10===0)console.error(JSON.stringify({phase:'backup',listed:list.size,saved,skipped,failed:failures.length}))
   await new Promise(r=>setTimeout(r,3000))
  }
  index.counts={...index.counts,local:Object.keys(index.conversations).length};atomic(indexPath,index)
  const complete=failures.length===0&&saved+skipped+reusedUnchanged===list.size
  result={...result,ok:complete,status:complete?'complete':'partial',root,listed:list.size,saved,skipped,reusedUnchanged,readRateLimitWaits,failures,listingProof,complete,attachmentFilesDownloaded:false,deletionReconciliation:false}
  atomic(join(root,'native-last-run.json'),result)
  if(!complete)process.exitCode=1
 }
 if(command==='ask'){
  const prompt=readFileSync(opt('--prompt-file'),'utf8')
  const catalog=await get('/models'),model=opt('--model')??catalog.default_model_slug
  const selected=catalog.models?.find(m=>m.slug===model)
  if(!selected||selected.is_work_mode_model===true||model.endsWith('-wm'))throw Error('Select an available ordinary ChatGPT model')
  if(job&&jobPath){if(job.question!==prompt)throw Error('Background job prompt changed; refusing to send');updateJob({identity,model,phase:'dispatching',submitted:'unknown'})}
  else{const created=newJob(root,{identity,question:prompt,model,timeoutMs});job=created.job;jobPath=created.path;updateJob({phase:'dispatching',submitted:'unknown'})}
  console.error(JSON.stringify({phase:'prepared',job:jobPath,timeoutMs,promptChars:prompt.length}))
  sendAttempted=true
  const response=await rpc('temporary-ask',{prompt,model,search:args.includes('--search'),timeoutMs})
  result={...result,...response,question:prompt}
  updateJob({phase:'answer-complete',conversationId:result.conversationId,result,submitted:true})
 }
 if(command==='recover'){
  jobPath=opt('--job');job=JSON.parse(readFileSync(jobPath,'utf8'))
  if(job.schema!=='chatgpt-native-job/v1'||job.identity?.email!==identity.email||job.identity.accountId!==identity.accountId||job.identity.userId!==identity.userId)throw Error('Recovery identity mismatch')
  if(job.result?.answer&&(job.result.streamDone||job.result.completionVerifiedBy==='remote-current-branch'))result={...job.result,ok:true}
  else{
   if(!/^[0-9a-f-]{36}$/i.test(job.conversationId??''))throw Error('No server conversation id was received; automatic resend is prohibited')
   await rpc('device-probe',{})
   const deadline=Date.now()+timeoutMs
   let completed=null
   while(Date.now()<deadline){
    try{completed=recoverCompletedAnswer(await get('/conversation/'+job.conversationId),job,identity);if(completed)break}
    catch(error){if(error.httpStatus!==429)throw error;console.error(JSON.stringify({phase:'recovery-read-rate-limit',job:jobPath}));await new Promise(r=>setTimeout(r,65000));continue}
    updateJob({phase:'recovering'});console.error(JSON.stringify({phase:'recovering-existing-conversation',job:jobPath}))
    await new Promise(r=>setTimeout(r,15000))
   }
   if(!completed)throw Error('Existing conversation has no completed answer yet; no question was resent')
   result=completed
  }
  updateJob({phase:'answer-complete',result,submitted:true})
 }
 if(['ask','recover'].includes(command)){
  result.sources=[...new Set([...result.answer.matchAll(/https?:\/\/[^\s)\]>]+/g)].map(m=>m[0]))]
  try{
   const page=await get('/conversations?offset=0&limit=20&order=updated')
   result.temporaryVerification={...result.temporaryVerification,absentFromRecentHistory:!page.items?.some(c=>c.id===result.conversationId)}
   try{const detail=await get('/conversation/'+result.conversationId);result.temporaryVerification.detailStatus=200;result.temporaryVerification.serverTemporaryFlag=detail.is_temporary_chat}
   catch(error){result.temporaryVerification.detailStatus=error.httpStatus??null}
  }catch{result.temporaryVerification={...result.temporaryVerification,verificationUnavailable:true}}
  if(!args.includes('--no-archive'))try{result.archive=await archiveNativeAnswer(result,{root})}
  catch(error){result.ok=false;result.answerGenerated=true;result.archive={ok:false,error:error.message};result.retryAutomatically=false;process.exitCode=1}
  result.job=jobPath
  updateJob({phase:result.ok?'done':'archive-failed',result,submitted:true})
 }
 if(opt('--output')){atomic(opt('--output'),result);console.log(JSON.stringify({ok:result.ok,status:result.status,output:opt('--output')}))}
 else console.log(JSON.stringify(result))
}catch(error){const failure={ok:false,code:error.code??error.message,httpStatus:error.httpStatus,serverCode:error.serverCode,errorShape:error.errorShape,job:jobPath,submitted:error.submitted??(sendAttempted?'unknown':false),retryAutomatically:false};updateJob({phase:'failed',error:failure,submitted:failure.submitted});console.error(JSON.stringify(failure));process.exitCode=1}
finally{clearTimeout(timer);lease?.release();child.stdin.end();stopChild()}
