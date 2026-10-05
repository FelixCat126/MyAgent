import { app, ipcMain, BrowserWindow, Notification, dialog, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeState } from './taskStore';
import { revealPortableRuntimeSecrets, protectPortableRuntimeSecrets } from './runtimeSecrets';
import { TaskLedger, emptyState } from './taskStore';
import { RuntimeScheduler } from './scheduler';
import { McpManager } from './mcpManager';
import { BackupService, BACKUP_LIMIT } from './backup';
import { revealPersistParsed, protectPersistParsed } from '../utils/securePersist';
import { flushPersistWrites } from '../ipc/persist';
import type { McpConnection, RuntimeSnapshot, RuntimeTask, TaskKind } from '../../src/features/runtime/api';
let ledger:TaskLedger|undefined;
let scheduler:RuntimeScheduler|undefined;
let backup:BackupService|undefined;
const mcp=new McpManager();
const executors=new Map<TaskKind,(task:RuntimeTask)=>Promise<void>>();
const cancellers=new Map<TaskKind,(task:RuntimeTask)=>void>();
export function registerRuntimeTaskExecutor(kind:TaskKind,executor:(task:RuntimeTask)=>Promise<void>):void{executors.set(kind,executor);}
export function registerRuntimeTaskCanceller(kind:TaskKind,cancel:(task:RuntimeTask)=>void):void{cancellers.set(kind,cancel);}
export async function getRuntimeLedger():Promise<TaskLedger>{await bootstrapRuntime();if(runtimeRecoveryError)throw new Error(runtimeRecoveryError);return ledger!;}
export function notifyRuntimeChanged():void{changed();}
function runExecutor(task:RuntimeTask):void{const execute=executors.get(task.kind);if(execute)void execute(task).catch(async error=>{await ledger!.finish(task.id,undefined,error instanceof Error?error.message:String(error));changed();});else dispatch(task);}
let bootstrapPromise:Promise<void>|undefined;
let runtimeRecoveryError:string|undefined;
let runtimeReady=false;
let shutdownPromise:Promise<void>|undefined;
let shuttingDown=false;
const credentialPrefix='runtime:secret:v1:';
function protectCredential(value:string):string{if(!value||value.startsWith(credentialPrefix))return value;if(!safeStorage.isEncryptionAvailable())throw new Error('系统密钥存储不可用，无法安全保存服务凭证');return credentialPrefix+safeStorage.encryptString(value).toString('base64');}
function revealCredential(value:string):string{if(!value.startsWith(credentialPrefix))return value;try{return safeStorage.decryptString(Buffer.from(value.slice(credentialPrefix.length),'base64'));}catch{return value;}}
function hasPersistCredentials(node:unknown):boolean{if(Array.isArray(node))return node.some(hasPersistCredentials);if(!node||typeof node!=='object')return false;return Object.entries(node).some(([key,value])=>(['apiKey','embeddingApiKey','volcAsrAppKey','volcAsrAccessKey','token'].includes(key)&&typeof value==='string'&&value.length>0)||(key==='env'&&value&&typeof value==='object'&&Object.values(value).some(v=>typeof v==='string'&&v.length>0))||hasPersistCredentials(value));}
function protectPortablePersist(raw:unknown):unknown{if(hasPersistCredentials(raw)&&!safeStorage.isEncryptionAvailable())throw new Error('系统密钥存储不可用，恢复已停止以免明文保存凭证');return protectPersistParsed(raw);}
function protectRuntime(raw:unknown):RuntimeState{const state=protectPortableRuntimeSecrets(structuredClone(raw) as RuntimeState,value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('系统密钥存储不可用，无法恢复服务凭证');return safeStorage.encryptString(value).toString('base64');});state.tasks=protectPersistParsed(state.tasks);state.connections=state.connections.map(c=>({...c,token:c.token?protectCredential(c.token):undefined,env:c.env?Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,protectCredential(v)])):undefined}));return state;}
function revealRuntime(raw:unknown):RuntimeState{const state=structuredClone(raw) as RuntimeState;state.tasks=revealPersistParsed(state.tasks) as RuntimeTask[];state.connections=state.connections.map(c=>({...c,token:c.token?revealCredential(c.token):undefined,env:c.env?Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,revealCredential(v)])):undefined}));return state;}
function publicConnection(connection:McpConnection):McpConnection{return{...connection,token:connection.token?'••••••••':undefined,env:connection.env?Object.fromEntries(Object.keys(connection.env).map(k=>[k,'••••••••'])):undefined,status:mcp.connected(connection.id)?'connected':'disconnected'};}
function snapshot():RuntimeSnapshot{return{tasks:ledger!.state.tasks,schedules:ledger!.state.schedules,connections:ledger!.state.connections.map(publicConnection),recoveryError:runtimeRecoveryError,pendingMcpCalls:mcp.pendingCalls()};}
function send(channel:string,value:unknown):void{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(channel,value);}
function changed():void{if(ledger)send('runtime-changed',snapshot());}
function dispatch(task:RuntimeTask):void{send('runtime-task-dispatch',task);}
function notify(title:string,body:string):void{if(Notification.isSupported())new Notification({title,body}).show();}
export async function bootstrapRuntime():Promise<void>{
  if(bootstrapPromise)return bootstrapPromise;
  bootstrapPromise=(async()=>{
    const userData=app.getPath('userData');ledger=new TaskLedger(path.join(userData,'runtime','state.json'),protectRuntime,revealRuntime);
    backup=new BackupService({userData,managedRoots:{documentVersions:path.join(userData,'document-workbench'),dataResults:path.join(app.getPath('documents'),'MyAgent','DataResults'),knowledge:path.join(userData,'knowledge'),uploads:path.join(userData,'myagent-uploads'),documents:path.join(app.getPath('documents'),'MyAgent','GeneratedDocuments'),images:path.join(app.getPath('documents'),'MyAgent','GeneratedImages'),videos:path.join(app.getPath('documents'),'MyAgent','GeneratedVideos')},reveal:revealPersistParsed,protect:protectPortablePersist,revealRuntime:raw=>revealPortableRuntimeSecrets(revealRuntime(raw),value=>safeStorage.decryptString(Buffer.from(value,'base64'))),protectRuntime});
    const versionFile=path.join(userData,'runtime','snapshot-version.txt');const previous=await fs.readFile(versionFile,'utf8').catch(()=>null);
    if(previous!==app.getVersion()){await backup.snapshot('upgrade');await fs.mkdir(path.dirname(versionFile),{recursive:true});await fs.writeFile(versionFile,app.getVersion(),{mode:0o600});}
    try{await ledger.load();runtimeRecoveryError=undefined;}catch(error){ledger.state=emptyState();runtimeRecoveryError=`任务数据库读取失败，原文件已保留，请从备份或快照恢复：${error instanceof Error?error.message:String(error)}`;}
    scheduler=new RuntimeScheduler(ledger,dispatch,notify,changed);runtimeReady=true;if(!runtimeRecoveryError)scheduler.start();changed();
  })();
  try{await bootstrapPromise;}catch(error){bootstrapPromise=undefined;throw error;}
}
export function shutdownRuntime():Promise<void>{
  if(shutdownPromise)return shutdownPromise;
  shuttingDown=true;
  shutdownPromise=(async()=>{
    if(bootstrapPromise)await bootstrapPromise.catch(()=>undefined);
    const active=ledger?.state.tasks.filter(task=>task.status==='running'||task.status==='awaiting_action')||[];
    const interrupted=runtimeReady&&ledger&&!runtimeRecoveryError?ledger.interruptActive():Promise.resolve();
    const cancellations=active.map(async task=>{cancellers.get(task.kind)?.(task);});
    const results=await Promise.allSettled([interrupted,scheduler?.stop(),mcp.shutdown(),flushPersistWrites(),...cancellations]);
    if(runtimeReady&&ledger&&!runtimeRecoveryError)await ledger.save();
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw Object.assign(new Error('Runtime shutdown failed'),{errors});
  })();
  return shutdownPromise;
}
export function registerRuntimeIpc():void{
  const handle=(channel:string,fn:(arg:any)=>unknown)=>ipcMain.handle(channel,async(_event,arg)=>{if(shuttingDown)throw new Error('应用正在退出，请重新打开后继续');await bootstrapRuntime();if(shuttingDown)throw new Error('应用正在退出，请重新打开后继续');if(runtimeRecoveryError&&!['runtime-get-state','runtime-list-snapshots','runtime-preview-backup','runtime-restore-backup','runtime-rollback-backup'].includes(channel))throw new Error(runtimeRecoveryError);return fn(arg);});
  handle('runtime-get-state',()=>snapshot());
  handle('runtime-create-task',async arg=>{const task=await ledger!.create(arg);changed();return task;});
  handle('runtime-claim-task',async id=>{const task=await ledger!.start(id);changed();return task;});
  handle('runtime-start-task',async id=>{if(ledger!.task(id).status==='running')return ledger!.task(id);const task=await ledger!.start(id);runExecutor(task);changed();return task;});
  handle('runtime-retry-task',async id=>{if(ledger!.task(id).status==='running')return ledger!.task(id);if(['reminder','web-monitor','directory-monitor'].includes(ledger!.task(id).kind))return scheduler!.retryTask(id);const task=await ledger!.start(id,true);runExecutor(task);changed();return task;});
  handle('runtime-complete-task',async arg=>{const task=await ledger!.finish(arg.id,arg.result,arg.error);changed();return task;});
  handle('runtime-record-step',async arg=>{const task=await ledger!.step(arg);changed();return task;});
  handle('runtime-save-checkpoint',async arg=>{const task=await ledger!.checkpoint(arg.id,arg.checkpoint);changed();return task;});
  handle('runtime-cancel-task',async id=>{const task=await ledger!.cancel(id);scheduler!.cancelTask(id);cancellers.get(task.kind)?.(task);send('runtime-task-cancel',id);changed();return task;});
  handle('runtime-save-schedule',async arg=>{const value=await ledger!.schedule(arg);changed();return value;});
  handle('runtime-delete-schedule',async id=>{ledger!.state.schedules=ledger!.state.schedules.filter(s=>s.id!==id);await ledger!.save();changed();});
  handle('runtime-run-schedule',id=>scheduler!.runNow(id));
  handle('runtime-choose-directory',async()=>{const result=await dialog.showOpenDialog({properties:['openDirectory']});if(result.canceled||!result.filePaths[0])return null;const directory=await fs.realpath(result.filePaths[0]);if(!ledger!.state.allowedDirectories.includes(directory))ledger!.state.allowedDirectories.push(directory);await ledger!.save();return directory;});
  handle('runtime-save-connection',async(arg:McpConnection)=>{const old=ledger!.state.connections.find(c=>c.id===arg.id);const input={...arg,token:arg.token==='••••••••'?old?.token:arg.token,env:arg.env?Object.fromEntries(Object.entries(arg.env).map(([k,v])=>[k,v==='••••••••'?old?.env?.[k]||'':v])):undefined};if(input.token||Object.values(input.env||{}).some(Boolean))protectRuntime({...ledger!.state,connections:[input]});await mcp.disconnect(arg.id);const value=await ledger!.connection(input);changed();return publicConnection(value);});
  handle('runtime-connect',async id=>{const connection=ledger!.state.connections.find(c=>c.id===id);if(!connection)throw new Error('连接不存在');if(connection.token?.startsWith(credentialPrefix)||Object.values(connection.env||{}).some(value=>value.startsWith(credentialPrefix)))throw new Error('服务凭证无法在本机解密，请重新填写或从口令备份恢复');const tools=await mcp.connect(connection);connection.enabled=true;await ledger!.save();changed();return tools;});
  handle('runtime-disconnect',async id=>{await mcp.disconnect(id);const connection=ledger!.state.connections.find(c=>c.id===id);if(connection)connection.enabled=false;await ledger!.save();changed();});
  handle('runtime-delete-connection',async id=>{await mcp.disconnect(id);ledger!.state.connections=ledger!.state.connections.filter(c=>c.id!==id);await ledger!.save();changed();});
  handle('runtime-list-tools',id=>mcp.listTools(id));
  handle('runtime-call-tool',async arg=>{const result=await mcp.call(arg.connectionId,arg.tool,arg.args);changed();return result;});
  handle('runtime-approve-mcp-call',async id=>{const result=await mcp.approve(id);send('runtime-mcp-result',{approvalId:id,result});changed();return result;});
  handle('runtime-cancel-mcp-call',async id=>{await mcp.cancel(id);send('runtime-mcp-result',{approvalId:id,result:{error:'用户拒绝或取消了本次工具调用'}});changed();});
  handle('runtime-list-snapshots',()=>backup!.listSnapshots());
  handle('runtime-export-backup',async arg=>{const result=await dialog.showSaveDialog({title:'保存加密完整备份',defaultPath:`MyAgent-${new Date().toISOString().slice(0,10)}.myagent`,filters:[{name:'MyAgent 加密备份',extensions:['myagent']}]});if(result.canceled||!result.filePath)return{path:null};await flushPersistWrites();await ledger!.save();const bundle=await backup!.export(arg.password);await fs.writeFile(result.filePath,bundle.bytes,{mode:0o600});return{path:result.filePath,files:bundle.files,bytes:bundle.bytes.length};});
  handle('runtime-preview-backup',async arg=>{const result=await dialog.showOpenDialog({title:'选择加密备份',properties:['openFile'],filters:[{name:'MyAgent 加密备份',extensions:['myagent']}]});if(result.canceled||!result.filePaths[0])return null;const stat=await fs.stat(result.filePaths[0]);if(stat.size>BACKUP_LIMIT+8*1024*1024)throw new Error('备份文件超过 512 MB');return backup!.preview(await fs.readFile(result.filePaths[0]),arg.password);});
  const ensureIdle=()=>{if(ledger!.state.tasks.some(t=>t.status==='running'||t.status==='awaiting_action'))throw new Error('请先停止正在运行的任务再恢复数据');};
  handle('runtime-restore-backup',async arg=>{ensureIdle();await flushPersistWrites();await mcp.shutdown();await scheduler!.stop();try{const result=await backup!.restore(arg.previewId,arg.mode);await ledger!.load();runtimeRecoveryError=undefined;changed();return result;}finally{if(!runtimeRecoveryError)scheduler!.start();}});
  handle('runtime-rollback-backup',async id=>{ensureIdle();await flushPersistWrites();await mcp.shutdown();await scheduler!.stop();try{const result=await backup!.rollback(id);await ledger!.load();runtimeRecoveryError=undefined;changed();return result;}finally{if(!runtimeRecoveryError)scheduler!.start();}});
}
