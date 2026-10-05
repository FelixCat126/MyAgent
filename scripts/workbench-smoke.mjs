import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

// Real Electron/preload/renderer/backend acceptance, using an isolated profile and loopback model.
const workspace=path.resolve(import.meta.dirname??path.dirname(new URL(import.meta.url).pathname),'..');
const base=await fs.mkdtemp(path.join(workspace,'node_modules/.myagent-workbench-smoke-'));
const data=path.join(base,'profile'),documents=path.join(base,'documents'),root=path.join(base,'project');
await Promise.all([fs.mkdir(path.join(data,'persist'),{recursive:true}),fs.mkdir(documents),fs.mkdir(root)]);
// Explicit opt-in only: avoid macOS authorization UI in a fresh, synthetic QA profile.
// This key is scoped to this harness invocation and reused only for its own restart.
const isolatedCredentials=process.env.MYAGENT_SMOKE_ISOLATED_CREDENTIALS==='1';
const credentialKey=isolatedCredentials?randomBytes(32).toString('hex'):undefined;
let credentialFixtureInstalls=0;
assert(path.isAbsolute(base)&&base.startsWith(path.join(workspace,'node_modules','.myagent-workbench-smoke-')));
assert.equal(await fs.realpath(base),base,'Smoke profile must not traverse a symlink');
const ocrFixture=process.env.MYAGENT_SMOKE_OCR_FIXTURE;
if(ocrFixture)await fs.copyFile(ocrFixture,path.join(root,'scan.pdf'));
const source=path.join(root,'sales.csv'); await fs.writeFile(source,'category,amount\nA,10\nA,20\nB,15\n');
const requests=[],discoveryRequests=[];
let failingDiscoveryMode='empty';
let showDarkDiscoveryCandidate=false;
const discoveryVerification={};
const layoutVerification={};
let discoveryExpectedState;
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    const failing=pathname.startsWith('/discovery-error/');
    const mode=failing?failingDiscoveryMode:'success';
    discoveryRequests.push({pathname,mode});
    // Keep the loading state observable through the real renderer/IPC request.
    await new Promise(resolve=>setTimeout(resolve,350));
    res.setHeader('Content-Type','application/json');
    if(mode==='http404'){res.statusCode=404;res.end(JSON.stringify({error:{message:'Fixture model catalog unavailable'}}));}
    else res.end(JSON.stringify({data:mode==='empty'?[]:[{id:'fixture-model'},{id:'fixture-new-model'},...(showDarkDiscoveryCandidate?[{id:'fixture-dark-candidate'}]:[])]}));
    return;
  }
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw); requests.push(body);
  const messages=body.messages||[],last=messages.at(-1),text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content||'');
  let message={content:text.includes('exact code')?'MYAGENT_HISTORY':text.includes('LEFT')?'left=unknown,right=unknown':'验收回答：流式输出、历史消息和任务记录均已正常完成。'};
  if(body.tools?.length&&!messages.some(m=>m.role==='tool')&&/计算|统计|汇总/.test(JSON.stringify(messages)))message={content:null,tool_calls:[{id:'fixture-data-call',type:'function',function:{name:'data_calculate',arguments:JSON.stringify({path:source,steps:[{op:'group',by:['category'],aggregates:[{column:'amount',function:'sum',as:'total'}]}],chart:{type:'bar',x:'category',y:'total'}})}}]};
  else if(messages.some(m=>m.role==='tool'))message={content:'已按真实数据完成汇总：A 类合计 30，B 类合计 15。计算结果和图表已附在下面。'};
  if(body.stream){res.setHeader('Content-Type','text/event-stream');res.write(`data: ${JSON.stringify({choices:[{delta:message.tool_calls?message:{reasoning_content:'先核对输入与历史，然后给出回答。'}}]})}\n\n`);if(!message.tool_calls)res.write(`data: ${JSON.stringify({choices:[{delta:{content:message.content}}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:message.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
  else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const model={id:'fixture',name:'验收模型',provider:'openai',apiUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture-only',modelName:'fixture-model',maxTokens:4096,contextWindow:32768,isLocal:false,chatApiMode:'openai'};
const legacyModels=[model,
 {...model,id:'local',name:'本地 Gemma',provider:'ollama',apiUrl:'http://127.0.0.1:11434',apiKey:undefined,modelName:'gemma:12b',isLocal:true,chatApiMode:'auto'},
 {...model,id:'image',name:'本地生图',isChatModel:false,isImageGenerator:true,isLocal:true,apiUrl:'',apiKey:undefined,modelName:'',imageGeneratorConfig:{type:'cli',command:'/fixture/image-generator',cliArgLines:'{{prompt}}\n{{outputPath}}',env:{FIXTURE:'retained'}}},
 ...['MiniMax','GLM','MiMo'].map((name,index)=>({...model,id:`cloud-${index}`,name,apiUrl:`https://fixture-${index}.example/v1`,apiKey:`synthetic-key-${index}`,modelName:`model-${index}`,chatApiMode:index===0?'anthropic':'openai'}))
];
const persist=async(name,state,version)=>fs.writeFile(path.join(data,'persist',`${name}.json`),JSON.stringify({state,version}));
await persist('model-storage',{models:legacyModels,activeModelId:'fixture',imageGenModelId:'image',routingRules:[]},3);
await persist('setting-storage',{locale:'zh',theme:'light',agentLocalToolsEnabled:true,agentBrowserEnabled:false,gestureControlEnabled:false,speechInputEnabled:false,voiceReplyEnabled:false},17);
await persist('project-storage',{projects:[{id:'long-project',name:'旧项目',rules:'SENTINEL_PROJECT_RULE',rootPath:root,createdAt:Date.now(),updatedAt:Date.now()}],activeProjectId:'long-project'},1);
const oldAnswer={id:'old-answer',role:'assistant',content:'旧回答和附件保留。',timestamp:Date.now(),model:'fixture-model'};
await persist('chat-storage',{sessions:[{id:'legacy-project-chat',title:'保留的历史对话',projectId:'long-project',createdAt:Date.now(),updatedAt:Date.now(),messages:[oldAnswer],activeLeafId:oldAnswer.id},{id:'legacy-orphan-chat',title:'另一条历史对话',projectId:'missing-project',createdAt:Date.now(),updatedAt:Date.now(),messages:[]}],currentSessionId:'legacy-project-chat',activeLeafId:oldAnswer.id},4);
await persist('memory-storage',{memories:[{id:'legacy-project-memory',content:'SENTINEL_PROJECT_MEMORY',scope:'project',projectId:'long-project',status:'confirmed',kind:'fact',alwaysApply:true,keywords:['sentinel'],source:{kind:'manual'},createdAt:Date.now(),updatedAt:Date.now()}]},1);
await persist('workflow-storage',{workflows:[{id:'legacy-recipe',name:'保留的配方',template:'请回复一句话：{{主题}}',projectId:'long-project',outputFormat:'auto',variables:[{name:'主题',label:'主题',defaultValue:'验收',required:true}],runCount:0,createdAt:Date.now(),updatedAt:Date.now()}]},1);
await persist('myagent-onboarding-dismissed',true,0);
let app,cdp;const errors=[];const logs=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitUntil(test,title,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await test())return;}catch{}await sleep(100);}throw new Error(`Timed out: ${title}`);}
async function inspectorTargets(port){
 const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2500)});
 if(!response.ok)throw new Error(`Inspector ${port} returned HTTP ${response.status}`);
 return response.json();
}
async function connectInspector(url,title){
 const endpoint=new URL(url);assert.equal(endpoint.protocol,'ws:');assert(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname),'Inspector must stay on loopback');
 const socket=new WebSocket(url,{handshakeTimeout:5000});
 let openTimeout;
 try{await Promise.race([once(socket,'open'),new Promise((_,reject)=>{openTimeout=setTimeout(()=>reject(new Error(`Timed out: ${title} WebSocket`)),6000);})]);}
 catch(error){socket.terminate();throw error;}finally{clearTimeout(openTimeout);}
 let id=0;const pending=new Map();
 const rejectPending=error=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();};
 socket.on('error',error=>rejectPending(error));socket.on('close',()=>rejectPending(new Error(`${title} inspector closed`)));
 socket.on('message',raw=>{let event;try{event=JSON.parse(raw);}catch{return;}if(event.id){const promise=pending.get(event.id);if(!promise)return;pending.delete(event.id);clearTimeout(promise.timer);event.error?promise.reject(new Error(event.error.message||'Inspector command failed')):promise.resolve(event.result);}else if(event.method==='Runtime.exceptionThrown')errors.push(event.params.exceptionDetails);});
 const command=(method,params={},timeout=15000)=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(new Error(`Timed out: ${title} ${method}`));},timeout);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}),error=>{if(error){clearTimeout(timer);pending.delete(next);reject(error);}});});
 const event=(method,timeout=15000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off('message',handler);reject(new Error(`Timed out: ${title} ${method}`));},timeout);const handler=raw=>{let message;try{message=JSON.parse(raw);}catch{return;}if(message.method===method){clearTimeout(timer);socket.off('message',handler);resolve(message.params);}};socket.on('message',handler);});
 return {command,event,close:()=>socket.close(),eval:async(expression)=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}};
}
async function installIsolatedCredentials(){
 assert(isolatedCredentials&&credentialKey,'Credential fixture requires explicit opt-in');
 let target;await waitUntil(async()=>{const targets=await inspectorTargets(9256);target=targets.find(item=>item.type==='node');return target;},'paused main-process inspector');
 const main=await connectInspector(target.webSocketDebuggerUrl,'main startup');
 let resumed=false;
 try{
  // Inspect-brk first stops the entry module before any application statement.
  // Its static builtin imports are already resolved; an async import here cannot
  // settle while paused, so obtain the existing crypto binding from that frame.
  const pausedEvent=main.event('Debugger.paused');
  await main.command('Debugger.enable');
  await main.command('Runtime.runIfWaitingForDebugger');
  const paused=await pausedEvent;
  let cryptoObject;
  for(const frame of paused.callFrames||[]){
   const source=await main.command('Debugger.getScriptSource',{scriptId:frame.location.scriptId});
   const alias=source.scriptSource.match(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](?:node:)?crypto['"]/)?.[1];
   if(!alias)continue;
   const resolved=await main.command('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:alias,returnByValue:false});
   if(!resolved.exceptionDetails&&resolved.result?.objectId){cryptoObject=resolved.result.objectId;break;}
  }
  if(!cryptoObject)throw new Error('Paused entry has no initialized static crypto import; application remains paused');
  // The secret is passed as a structured argument, never embedded in source or logs.
  const installed=await main.command('Runtime.callFunctionOn',{objectId:cryptoObject,functionDeclaration:`function(keyHex){
   if(process.env.MYAGENT_SMOKE_ISOLATED_CREDENTIALS!=='1'||process.env.MYAGENT_TEST_MODE!=='1'||process.env.MYAGENT_TEST_DATA_DIR!==${JSON.stringify(data)}||process.env.MYAGENT_TEST_DOCUMENTS_DIR!==${JSON.stringify(documents)})throw new Error('Isolated credential fixture rejected non-test profile');
   const crypto=this;
   const binding=process._linkedBinding('electron_browser_safe_storage');
   const storage=binding.safeStorage||binding;
   if(typeof storage.isEncryptionAvailable!=='function'||typeof storage.encryptString!=='function'||typeof storage.decryptString!=='function')throw new Error('Electron safeStorage binding unavailable');
   const key=Buffer.from(keyHex,'hex'),magic=Buffer.from('MYAGENT-QA-AESGCM-1:');
   if(key.length!==32)throw new Error('Invalid isolated credential fixture key');
   const encryptString=plain=>{if(typeof plain!=='string')throw new TypeError('Credential must be a string');const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce),body=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);return Buffer.concat([magic,nonce,cipher.getAuthTag(),body]);};
   const decryptString=value=>{if(!Buffer.isBuffer(value)||value.length<magic.length+28||!value.subarray(0,magic.length).equals(magic))throw new Error('Isolated credential fixture cannot decrypt this value');const offset=magic.length,decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(offset,offset+12));decipher.setAuthTag(value.subarray(offset+12,offset+28));return Buffer.concat([decipher.update(value.subarray(offset+28)),decipher.final()]).toString('utf8');};
   if(decryptString(encryptString('fixture-probe'))!=='fixture-probe')throw new Error('Isolated credential fixture roundtrip failed');
   Object.defineProperties(storage,{isEncryptionAvailable:{value:()=>true,configurable:true,writable:true},encryptString:{value:encryptString,configurable:true,writable:true},decryptString:{value:decryptString,configurable:true,writable:true}});
   return {installed:true,credentialStorage:'isolatedEncryptedFixture'};
  }`,arguments:[{value:credentialKey}],returnByValue:true});
  if(installed.exceptionDetails)throw new Error('Unable to install isolated credential fixture: '+(installed.exceptionDetails.exception?.description||installed.exceptionDetails.text).replaceAll(credentialKey,'[redacted]'));
  assert.deepEqual(installed.result?.value,{installed:true,credentialStorage:'isolatedEncryptedFixture'});
  credentialFixtureInstalls++;
  await main.command('Debugger.resume');
  resumed=true;
 }finally{
  // Detaching a debugger can resume a paused process. On installation failure,
  // keep it paused until the harness finally block stops its own QA process.
  if(resumed)main.close();
 }
}
async function start(){
 const env={...process.env,MYAGENT_TEST_MODE:'1',MYAGENT_TEST_DATA_DIR:data,MYAGENT_TEST_DOCUMENTS_DIR:documents};delete env.ELECTRON_RUN_AS_NODE;
 const binary=process.env.MYAGENT_SMOKE_BINARY||path.join(workspace,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
 const debugArg=isolatedCredentials?'--inspect-brk=9256':'--inspect=9256';
 const args=process.env.MYAGENT_SMOKE_BINARY?['--remote-debugging-port=9255',debugArg]:['--remote-debugging-port=9255',debugArg,workspace];
 app=spawn(binary,args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});app.stdout.on('data',b=>logs.push(b.toString()));app.stderr.on('data',b=>logs.push(b.toString()));
 if(isolatedCredentials)await installIsolatedCredentials();
 let target;await waitUntil(async()=>{const targets=await inspectorTargets(9255);target=targets.find(t=>t.type==='page'&&t.url.includes('index.html'));return target;},'Electron page');
 cdp=await connectInspector(target.webSocketDebuggerUrl,'renderer');
 await cdp.command('Runtime.enable');await waitUntil(()=>cdp.eval('Boolean(window.electron?.runtimeGetState && document.querySelector("button"))'),'preload + renderer');
 if(!await cdp.eval('Boolean(document.querySelector("textarea"))'))await cdp.eval('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="新对话").click()');
 await waitUntil(()=>cdp.eval('Boolean(document.querySelector("textarea"))'),'composer');
}
async function stop(){cdp?.close();if(app&&app.exitCode===null){app.kill('SIGTERM');await Promise.race([once(app,'exit'),sleep(5000)]);if(app.exitCode===null)app.kill('SIGKILL');}}
async function quitNormally(){
 // Exercise Electron's before-quit cleanup rather than terminating the process.
 const targets=await inspectorTargets(9256);
 const main=await connectInspector(targets[0].webSocketDebuggerUrl,'normal shutdown');
 const exited=once(app,'exit');
 const requested=main.eval("process._linkedBinding('electron_browser_app').app.quit()");
 await Promise.race([requested,sleep(1000)]).catch(error=>{if(app.exitCode===null)throw error;});main.close();
 await Promise.race([exited,sleep(10000).then(()=>{throw new Error('Normal application shutdown did not finish');})]);
 cdp?.close();assert.equal(app.exitCode,0,'Normal quit must exit successfully');
}
async function click(text){return cdp.eval(`(()=>{const button=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.closest('[hidden],[aria-hidden="true"]')).find(b=>b.innerText.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.title===${JSON.stringify(text)});if(!button)throw new Error('Button missing: '+${JSON.stringify(text)});button.click();return true})()`);}
async function type(selector,text){await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);await cdp.command('Input.insertText',{text});}
async function send(text){const previous=new Set((await cdp.eval('window.electron.runtimeGetState()')).tasks.map(t=>t.id));await type('textarea',text);await click('发送 (回车)');await waitUntil(async()=>{const state=await cdp.eval('window.electron.runtimeGetState()');return state.tasks.some(task=>!previous.has(task.id)&&task.status==='completed');},'completed new model task');await waitUntil(()=>cdp.eval('[...document.querySelectorAll("button")].filter(b=>!b.closest("[hidden],[aria-hidden=true]")).every(b=>b.innerText.trim()!=="停止")'),'finished visible streaming');}
async function screenshot(name){await sleep(200);await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const shot=await cdp.command('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(base,name),Buffer.from(shot.data,'base64'));}
async function selectSettingsTab(title){await cdp.eval(`(()=>{const tab=[...document.querySelectorAll('[role=tab]')].find(b=>b.querySelector('span')?.textContent===${JSON.stringify(title)});if(!tab)throw new Error('Tab missing');tab.click()})()`);}
async function savedStore(key){return JSON.parse(await cdp.eval(`window.electron.persistGet(${JSON.stringify(key)})`)).state;}
async function verifyTaskEntry(locale='zh',openDialog=false){
 const title=locale==='en'?'Task center':'任务中心';
 const entry=await cdp.eval(`(()=>{const button=document.querySelector('[data-testid="task-center-entry"]');const header=document.querySelector('[data-testid="app-titlebar-actions"]');if(!button||!header)return null;const b=button.getBoundingClientRect(),h=header.getBoundingClientRect();return {text:button.innerText.trim(),title:button.title,label:button.getAttribute('aria-label'),popup:button.getAttribute('aria-haspopup'),expanded:button.getAttribute('aria-expanded'),icons:button.querySelectorAll('svg').length,count:document.querySelectorAll('[data-testid="task-center-entry"]').length,width:b.width,height:b.height,top:b.top,headerBottom:h.bottom,rightGap:h.right-b.right,headerWidth:h.width,lastButton:[...header.querySelectorAll('button')].filter(node=>node.getClientRects().length).at(-1)===button}})()`);
 assert(entry,'Task entry and titlebar must be mounted');assert.equal(entry.count,1);assert.equal(entry.text,'');assert.equal(entry.title,title);assert.equal(entry.label,title);assert.equal(entry.popup,'dialog');assert.equal(entry.expanded,'false');assert.equal(entry.icons,1);assert.equal(entry.lastButton,true);
 assert(entry.width>=28&&entry.height>=28,'Task icon must retain a usable hit area');assert(entry.top>=0&&entry.top<entry.headerBottom,'Task entry must remain in the titlebar');assert(entry.rightGap>=8&&entry.rightGap<=32,'Task icon must be aligned to the titlebar right edge');
 assert.equal(await cdp.eval(`[...document.querySelectorAll('button')].filter(button=>button.getClientRects().length).some(button=>/^(工作空间|图片工作台|Workspace|Image workbench)$/.test(button.innerText.trim())||/^(工作空间|图片工作台|Workspace|Image workbench)$/.test(button.getAttribute('aria-label')||''))`),false,'Removed workbenches must have no visible entry');
 if(openDialog){await click(title);await waitUntil(()=>cdp.eval(`Boolean(document.querySelector('[role=dialog][aria-label=${JSON.stringify(title)}]'))`),'task center dialog');assert.equal(await cdp.eval('document.querySelector("[data-testid=task-center-entry]").getAttribute("aria-expanded")'),'true');await click(locale==='en'?'Close':'关闭');await waitUntil(()=>cdp.eval(`!document.querySelector('[role=dialog][aria-label=${JSON.stringify(title)}]')`),'task center closes');}
 layoutVerification.taskCenterIcon={rightGap:entry.rightGap,width:entry.width,height:entry.height,iconOnly:true,rightAligned:true,accessible:true,dialogVerified:true};
}
async function verifyImageSelectionSpacing(view,snapshot){
 await waitUntil(()=>cdp.eval('Boolean(document.querySelector("[role=tabpanel]:not([hidden]) [data-testid=image-model-selection] select"))'),'image model selection');
 await cdp.eval('document.querySelector("[role=tabpanel]:not([hidden]) [data-testid=image-model-selection]").scrollIntoView({block:"center"})');
 const spacing=await cdp.eval(`(()=>{const block=document.querySelector('[role=tabpanel]:not([hidden]) [data-testid=image-model-selection]');const content=block.querySelector('[data-testid=image-model-selection-content]');const label=content?.querySelector('label'),select=content?.querySelector('select[aria-label="生图模型"]'),hint=select?.nextElementSibling;if(!label||!select||!hint)return null;const b=block.getBoundingClientRect(),c=content.getBoundingClientRect(),l=label.getBoundingClientRect(),s=select.getBoundingClientRect(),h=hint.getBoundingClientRect();return {separatorGap:c.top-block.previousElementSibling.getBoundingClientRect().bottom,top:l.top-b.top,separatorPadding:l.top-c.top-parseFloat(getComputedStyle(content).borderTopWidth),labelToSelect:s.top-l.bottom,selectToHint:h.top-s.bottom,bottom:b.bottom-h.bottom,visible:s.top>=0&&h.bottom<=innerHeight,width:b.width,overflow:block.scrollWidth>block.clientWidth+1,value:select.value}})()`);
 assert(spacing,'Image selector must have measurable content');assert(spacing.separatorGap>=15.5,'Last model card must have at least 16 CSS pixels before the divider');assert(spacing.top>=15.5&&spacing.separatorPadding>=15.5,'Image selection needs at least 16 CSS pixels above its label');assert(spacing.bottom>=15.5,'Image selection needs at least 16 CSS pixels below its hint');assert(spacing.labelToSelect>=7.5&&spacing.selectToHint>=7.5,'Image selection controls need at least 8 CSS pixels between groups');assert.equal(spacing.visible,true);assert.equal(spacing.overflow,false);assert.equal(spacing.value,'image','Spacing changes must preserve the selected image model');
 layoutVerification[view]=spacing;if(snapshot)await screenshot(snapshot);
 await cdp.eval('(()=>{for(let node=document.querySelector("[data-testid=image-model-selection]").parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight)node.scrollTop=0})()');
}
async function discoverConnection(connection){
 assert.equal(new URL(connection.apiUrl).origin,new URL(model.apiUrl).origin,'Discovery must use only the loopback fixture');
 await cdp.eval(`(()=>{const panel=document.querySelector('[role=tabpanel]:not([hidden])');const card=[...panel.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')===${JSON.stringify(`编辑连接 ${connection.name}`)}).map(b=>b.parentElement.parentElement).find(c=>c.querySelector('p[title]')?.getAttribute('title')===${JSON.stringify(connection.apiUrl)});const discover=card?.querySelector('button[title="发现模型"]');if(!discover)throw new Error('Fixture discovery button missing');discover.click()})()`);
 await waitUntil(()=>cdp.eval('Boolean(document.querySelector("[role=tabpanel]:not([hidden]) [aria-busy=true] [role=status]"))'),'visible model discovery loading');
}
async function discoveredModelState(id){
 return cdp.eval(`(()=>{const input=[...document.querySelectorAll('[role=tabpanel]:not([hidden]) input[type=checkbox]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(id)});return input?{checked:input.checked,disabled:input.disabled,text:input.closest('label').innerText}:null})()`);
}
async function setConnectionField(label,value){
 await cdp.eval(`(()=>{const panel=document.querySelector('[role=tabpanel]:not([hidden])');const input=[...panel.querySelectorAll('label')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input');if(!input)throw new Error('Connection field missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function assertDiscoveryFailure(connection,expected){
 await waitUntil(()=>cdp.eval('Boolean(document.querySelector("[role=tabpanel]:not([hidden]) [role=alert]"))'),'persistent discovery error');
 const read=()=>cdp.eval(`(()=>{const panel=document.querySelector('[role=tabpanel]:not([hidden])');const form=panel.querySelector('[aria-busy]');return {error:form?.querySelector('[role=alert]')?.innerText,retry:[...panel.querySelectorAll('button')].some(b=>b.innerText.trim()==='重试发现'&&!b.disabled),back:[...panel.querySelectorAll('button')].some(b=>b.innerText.trim()==='返回'),name:form?.querySelector('p')?.innerText,modelCount:form?.querySelectorAll('input[type=checkbox]').length}})()`);
 const first=await read();assert.match(first.error,expected);assert.equal(first.retry,true);assert.equal(first.back,true);assert.equal(first.name,connection.name);assert.equal(first.modelCount,0);
 await sleep(650);assert.deepEqual(await read(),first,'Discovery error and recovery controls must remain visible');
 assert.deepEqual((await savedStore('connection-storage')).connections.find(item=>item.id===connection.id),connection,'Discovery errors must preserve the service configuration');
}
async function verifyModelDiscovery(organized,services){
 const fixture=services.connections.find(connection=>connection.id===organized.models.find(item=>item.id==='fixture').connectionId);assert(fixture);
 await discoverConnection(fixture);
 await waitUntil(async()=>Boolean(await discoveredModelState('fixture-new-model')),'fixture catalog list');
 assert.equal(discoveryRequests.at(-1).pathname,'/v1/models');
 const added=await discoveredModelState('fixture-model'),pending=await discoveredModelState('fixture-new-model');
 assert.equal(added.checked,true);assert.equal(added.disabled,true);assert.match(added.text,/已添加|Added/);
 assert.equal(pending.checked,false);assert.equal(pending.disabled,false);assert.doesNotMatch(pending.text,/已添加|Added/);
 await cdp.eval('document.querySelector("[role=tabpanel]:not([hidden]) input[aria-label=fixture-new-model]").click()');
 assert.equal((await discoveredModelState('fixture-new-model')).checked,true);
 await click('添加 1 个模型');
 await waitUntil(async()=>(await savedStore('model-storage')).models.length===organized.models.length+1,'persisted discovered model');
 const after=await savedStore('model-storage');
 for(const original of organized.models)assert.deepEqual(after.models.find(item=>item.id===original.id),original,`Adding a model must preserve ${original.id}`);
 assert.equal(after.activeModelId,organized.activeModelId);assert.equal(after.imageGenModelId,organized.imageGenModelId);assert.deepEqual(after.routingRules,organized.routingRules);
 const newModels=after.models.filter(item=>!organized.models.some(old=>old.id===item.id));assert.equal(newModels.length,1);assert.equal(newModels[0].modelName,'fixture-new-model');assert.equal(newModels[0].connectionId,fixture.id);
 assert.deepEqual((await savedStore('connection-storage')).connections,services.connections);
 await discoverConnection(fixture);
 await waitUntil(async()=>Boolean(await discoveredModelState('fixture-new-model')),'rediscovered fixture catalog');
 for(const id of ['fixture-model','fixture-new-model']){const item=await discoveredModelState(id);assert.equal(item.checked,true);assert.equal(item.disabled,true);assert.match(item.text,/已添加|Added/);}
 assert.equal(await cdp.eval('[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find(b=>b.innerText.trim()==="添加选中模型")?.disabled'),true);
 await screenshot('15-discovery-success.png');await click('返回');
 await click('添加服务连接');
 await setConnectionField('连接名称','发现失败验收服务');
 await setConnectionField('服务地址',`${new URL(model.apiUrl).origin}/discovery-error/v1`);
 await setConnectionField('API Key','fixture-error-only');
 await click('保存连接');
 await waitUntil(async()=>Boolean((await savedStore('connection-storage')).connections.find(item=>item.name==='发现失败验收服务')),'synthetic failure service');
 const failing=(await savedStore('connection-storage')).connections.find(item=>item.name==='发现失败验收服务');
 failingDiscoveryMode='empty';await discoverConnection(failing);await assertDiscoveryFailure(failing,/空|可用模型|模型列表/);
 const failedRequests=()=>discoveryRequests.filter(item=>item.pathname==='/discovery-error/v1/models');
 assert.equal(failedRequests().length,1);assert.equal(failedRequests().at(-1).mode,'empty');
 failingDiscoveryMode='http404';const retries=failedRequests().length;await click('重试发现');
 await waitUntil(()=>failedRequests().length>retries,'real catalog retry');await assertDiscoveryFailure(failing,/404/);
 assert.equal(failedRequests().length,2);assert.equal(failedRequests().at(-1).mode,'http404');
 assert.deepEqual(await savedStore('model-storage'),after,'Failed discovery must not change models, routing or defaults');
 assert.deepEqual((await savedStore('connection-storage')).connections, [...services.connections,failing]);
 await screenshot('16-discovery-error.png');await click('返回');
 assert(await cdp.eval(`document.querySelector('[role=tabpanel]:not([hidden])').innerText.includes(${JSON.stringify(failing.apiUrl)})`),'Returning from discovery keeps the service URL visible');
 discoveryExpectedState={model:after,connections:[...services.connections,failing]};
 Object.assign(discoveryVerification,{existingCheckedAndDisabled:true,onlySelectedModelAdded:true,defaultsAndOldModelsPreserved:true,rediscoveryMarksBothAdded:true,loadingVisible:true,emptyErrorPersistent:true,http404ErrorPersistent:true,retryVerified:true,serviceConfigurationPreserved:true});
}
async function verifySettings(){
 await waitUntil(async()=>(await savedStore('model-storage')).connectionMigrationVersion===1,'automatic legacy connection organization');
 const organized=await savedStore('model-storage'),services=await savedStore('connection-storage');
 assert.equal(services.connections.length,5);assert.equal(organized.models.filter(m=>m.connectionId).length,5);
 assert.equal(organized.activeModelId,'fixture');assert.equal(organized.imageGenModelId,'image');
 for(const original of legacyModels){const migrated=organized.models.find(m=>m.id===original.id);if(original.id==='image')assert.deepEqual(migrated,JSON.parse(JSON.stringify(original)));else{const connection=services.connections.find(c=>c.id===migrated.connectionId);assert(connection);for(const key of ['apiUrl','provider','apiKey','chatApiMode','isLocal'])assert.equal(key==='apiKey'&&!original[key]?connection[key]||undefined:connection[key],original[key],`${original.id} ${key}`);}}
 const diskModels=JSON.parse(await fs.readFile(path.join(data,'persist/model-storage.json'),'utf8')).state;
 const diskServices=JSON.parse(await fs.readFile(path.join(data,'persist/connection-storage.json'),'utf8')).state;
 assert(diskModels.models.filter(m=>m.apiKey).every(m=>m.apiKey.startsWith('enc:v1:')),'Migrated model keys must remain encrypted on disk');
 assert(diskServices.connections.filter(c=>c.apiKey).every(c=>c.apiKey.startsWith('enc:v1:')),'Organized service keys must be encrypted on disk');
 await click('设置');await waitUntil(()=>cdp.eval('document.querySelector("[data-gesture-drawer-open=true]")?.getBoundingClientRect().right<=innerWidth+1'),'settings animation');
 assert.equal(await cdp.eval('document.querySelectorAll(".model-settings-hub").length'),1);
 assert.equal(await cdp.eval('[...document.querySelectorAll("[role=tabpanel]")].filter(p=>!p.hidden).length'),1);
 await screenshot('05-model-settings.png');
 await cdp.eval('[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find(b=>b.title==="编辑").click()');
 await waitUntil(()=>cdp.eval('Boolean(document.querySelector("[role=tabpanel]:not([hidden]) select[aria-label=用途]"))'),'shared model form');
 assert.equal(await cdp.eval('document.querySelectorAll("[role=tabpanel]:not([hidden]) input[type=password]").length'),0,'Shared model editing must not repeat the service key');
 await screenshot('13-shared-model-form.png');await click('取消');
 await verifyImageSelectionSpacing('imageSelectionDesktop','11-image-selection-spacing.png');
 await selectSettingsTab('服务连接');await screenshot('06-service-settings.png');await verifyModelDiscovery(organized,services);await click('添加服务连接');
 await type('[role=tabpanel]:not([hidden]) label input','保留的未保存草稿');
 await selectSettingsTab('语音与回答');assert((await cdp.eval('document.querySelector("[role=tabpanel]:not([hidden])").innerText')).includes('语音回答长度'));await screenshot('07-voice-settings.png');
 await selectSettingsTab('服务连接');assert.equal(await cdp.eval('document.querySelector("[role=tabpanel]:not([hidden]) label input").value'),'保留的未保存草稿');await click('取消');
 await selectSettingsTab('视频模型');await screenshot('08-video-settings.png');
 await cdp.command('Emulation.setDeviceMetricsOverride',{width:1000,height:760,deviceScaleFactor:1,mobile:false});
 await selectSettingsTab('对话与图片');await verifyImageSelectionSpacing('imageSelectionNarrow','09-settings-narrow.png');
 assert(await cdp.eval('(()=>{const p=document.querySelector(".model-settings-hub");return p.scrollWidth<=p.clientWidth+1})()'),'Settings must not overflow horizontally');
 await click('关闭');await cdp.eval('[...document.querySelectorAll("button")].find(b=>b.title.startsWith("在跟随系统")).click()');
 await click('切换界面语言');await click('Settings');await selectSettingsTab('Services');await screenshot('10-settings-dark.png');
 showDarkDiscoveryCandidate=true;await click('Discover');await waitUntil(async()=>Boolean(await discoveredModelState('fixture-dark-candidate')),'dark discovery list');
 const darkDiscovery=await cdp.eval(`(()=>{const panel=document.querySelector('[role=tabpanel]:not([hidden])'),added=panel.querySelector('input[aria-label="fixture-model"]')?.closest('label'),available=panel.querySelector('input[aria-label="fixture-dark-candidate"]')?.closest('label');if(!added||!available)return null;const rgb=value=>(value.match(/[\\d.]+/g)||[]).slice(0,3).map(Number);const luminance=value=>rgb(value).map(channel=>{const c=channel/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4}).reduce((sum,channel,index)=>sum+channel*[0.2126,0.7152,0.0722][index],0);const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);const addedName=added.querySelector('span.min-w-0'),availableName=available.querySelector('span.min-w-0'),box=added.querySelector('span[aria-hidden="true"]'),check=box?.querySelector('svg'),checkbox=added.querySelector('input');const foreground=getComputedStyle(addedName).color,background=getComputedStyle(added).backgroundColor,availableForeground=getComputedStyle(availableName).color;return {dark:document.body.classList.contains('dark'),foreground,background,contrast:contrast(foreground,background),fontSize:parseFloat(getComputedStyle(addedName).fontSize),addedLabel:added.innerText.includes('Added'),addedState:added.dataset.state,availableState:available.dataset.state,availableContrast:contrast(availableForeground,getComputedStyle(available).backgroundColor),visuallyMuted:luminance(foreground)<luminance(availableForeground),checkboxChecked:checkbox.checked,checkboxDisabled:checkbox.disabled,checkVisible:Boolean(check),checkContrast:check?contrast(getComputedStyle(check).color,getComputedStyle(box).backgroundColor):0,boxOpacity:getComputedStyle(box).opacity}})()`);
 assert(darkDiscovery?.dark&&darkDiscovery.addedLabel&&darkDiscovery.addedState==='added'&&darkDiscovery.availableState==='available','Added and available models must remain distinct in dark mode');
 assert(darkDiscovery.contrast>=7&&darkDiscovery.availableContrast>=7&&darkDiscovery.fontSize>=14&&darkDiscovery.visuallyMuted,'Added model should be slightly muted while both model names stay readable');
 assert(darkDiscovery.checkboxChecked&&darkDiscovery.checkboxDisabled&&darkDiscovery.checkVisible&&darkDiscovery.checkContrast>=7&&darkDiscovery.boxOpacity==='1','Disabled added checkbox must have a clear custom check mark');
 layoutVerification.darkDiscoveryText=darkDiscovery;
 await screenshot('17-discovery-dark.png');showDarkDiscoveryCandidate=false;await click('Back');await click('Close');await verifyTaskEntry('en');await click('Switch UI language');
 await cdp.eval('[...document.querySelectorAll("button")].find(b=>b.title.startsWith("在跟随系统")).click()');await cdp.eval('[...document.querySelectorAll("button")].find(b=>b.title.startsWith("在跟随系统")).click()');
 await cdp.command('Emulation.clearDeviceMetricsOverride');
}
try{
 await start();
 const legacyDataSnapshot={projects:await savedStore('project-storage'),memories:await savedStore('memory-storage'),workflows:await savedStore('workflow-storage')};
 await verifyTaskEntry('zh',true);
 await cdp.eval('window.dispatchEvent(new CustomEvent("myagent:media-workbench-open"))');
 await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await cdp.eval('document.querySelector("[role=dialog][aria-label=图片工作台]")'),null,'Retired media events must not open a workbench');
 await verifySettings();
 assert.equal(await cdp.eval('document.querySelector("nav[aria-label=对话浏览范围]")'),null,'Project navigation must be removed');
 assert.equal(await cdp.eval('document.querySelector("button[aria-label=新对话]").innerText.trim()'),'新对话','New-chat button must restore its single-line label');
 assert((await cdp.eval('document.body.innerText')).includes('保留的历史对话'));
 assert((await cdp.eval('document.body.innerText')).includes('另一条历史对话'));
 assert((await cdp.eval('document.body.innerText')).includes(oldAnswer.content));
 const report=await cdp.eval(`window.electron.diagnoseModel(${JSON.stringify(model)},['chat','history','stream','tools','vision'])`);
 assert.equal(report.checks.find(c=>c.kind==='chat').status,'verified');assert.equal(report.checks.find(c=>c.kind==='history').status,'verified');assert.equal(report.checks.find(c=>c.kind==='stream').status,'verified');assert.equal(report.checks.find(c=>c.kind==='tools').status,'failed');assert.equal(report.checks.find(c=>c.kind==='vision').status,'failed');
 if(ocrFixture){const scanned=await cdp.eval(`window.electron.inspectDocument({path:${JSON.stringify(path.join(root,'scan.pdf'))},ocr:true})`);assert(scanned.ok);assert(scanned.document.pages.some(page=>page.method==='ocr'&&/67890/.test(page.text)));const rendered=await cdp.eval(`window.electron.renderDocumentPage({path:${JSON.stringify(path.join(root,'scan.pdf'))},page:1})`);assert(rendered.ok&&rendered.width>0);}
 await send('验收对话，请回复一句话。');assert((await cdp.eval('document.body.innerText')).includes('验收回答'));
 assert(!JSON.stringify(requests.at(-1)).includes('SENTINEL_PROJECT_RULE'),'Legacy project rules must not be sent');
 assert(!JSON.stringify(requests.at(-1)).includes('SENTINEL_PROJECT_MEMORY'),'Legacy project memory must not be promoted');
 await screenshot('01-chat.png');
 await send('继续验收普通对话，请保持回答清楚。');
 await click('新对话');
 await waitUntil(async()=>{const value=await savedStore('chat-storage');return value.currentSessionId!=='legacy-project-chat'&&value.sessions.find(s=>s.id===value.currentSessionId)?.projectId==null;},'Ordinary conversation opens without a personal workspace');
 await screenshot('12-flat-conversation-history.png');
 // Chromium file input produces a real File, exercising upload + attachment enrichment.
 const dom=await cdp.command('DOM.getDocument');const node=await cdp.command('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'input[type=file]'});await cdp.command('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[source]});
 await type('textarea','按 category 计算 amount 合计，生成汇总表和柱状图。');await click('发送 (回车)');
 await waitUntil(async()=>{const state=await cdp.eval('window.electron.runtimeGetState()');return state.tasks.some(t=>t.title.includes('category')&&t.status==='completed');},'agent data tool',30000);
 const state=await cdp.eval('window.electron.runtimeGetState()');const task=state.tasks.find(t=>t.title.includes('category'));assert(task.steps.some(step=>step.title==='data_calculate'&&step.status==='completed'));
 const result=task.steps.find(step=>step.title==='data_calculate').result;assert(result.exportFiles.some(f=>f.name==='result.xlsx'));assert(result.exportFiles.some(f=>f.name==='chart.svg'));await screenshot('02-data-chat.png');
 const inspected=await cdp.eval(`window.electron.inspectDocument({path:${JSON.stringify(source)}})`);assert(inspected.ok);assert(inspected.document.table.range.includes('A1'));
 const saved=await cdp.eval(`window.electron.saveDocumentVersion(${JSON.stringify({documentId:inspected.document.id,baseVersionId:inspected.document.activeVersionId,cells:[{sheet:inspected.document.table.sheet,address:'B2',value:99}],formats:['xlsx']})})`);assert(saved.ok);assert.equal(saved.document.versions.length,2);
 const restored=await cdp.eval(`window.electron.restoreDocumentVersion(${JSON.stringify({documentId:inspected.document.id,versionId:inspected.document.activeVersionId})})`);assert(restored.ok);assert.equal(restored.document.versions.length,3);
 const event=await fs.readFile(path.join(workspace,'src/features/documents/events.ts'),'utf8');const eventName=event.match(/=\s*['"]([^'"]+)['"]/)?.[1];assert(eventName);
 await cdp.eval(`window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)},{detail:${JSON.stringify({path:source,name:'sales.csv',type:'text/csv',size:50})}}))`);await waitUntil(()=>cdp.eval('Boolean(document.querySelector("[aria-label=文档工作台] table"))'),'rendered document table');await screenshot('03-document.png');await click('关闭文档工作台');
 await click('任务中心');await waitUntil(()=>cdp.eval('document.querySelector("[role=dialog][aria-label=任务中心]")?.innerText.includes("任务记录")'),'task center records');await screenshot('04-task-center.png');await click('关闭');
 const previousSession=(await savedStore('chat-storage')).currentSessionId;await click('新对话');
 await waitUntil(async()=>{const value=await savedStore('chat-storage');return value.currentSessionId!==previousSession&&value.sessions.find(s=>s.id===value.currentSessionId)?.projectId==null;},'New chat does not inherit a legacy project');
 await send('验收普通对话。');await screenshot('14-new-general-conversation.png');
 await cdp.eval('window.electron.showQuickPanel()');await waitUntil(async()=>{const targets=await inspectorTargets(9255);return targets.some(t=>t.type==='page'&&t.url.startsWith('data:'));},'real quick window');
 await sleep(300);await quitNormally();await start();
 const modelSaved=await cdp.eval(`window.electron.persistGet('model-storage')`);assert(JSON.parse(modelSaved).state.models.some(m=>m.id==='fixture'&&m.apiKey==='fixture-only'));
 assert.equal(JSON.parse(modelSaved).state.models.filter(m=>m.connectionId).length,6);assert.equal((await savedStore('connection-storage')).connections.length,6);assert.equal(JSON.parse(modelSaved).state.imageGenModelId,'image');assert.equal(JSON.parse(modelSaved).state.activeModelId,'fixture');
 assert.equal(JSON.parse(modelSaved).state.models.filter(m=>m.modelName==='fixture-new-model').length,1,'Discovered model must survive restart without duplication');
 assert.deepEqual(JSON.parse(modelSaved).state,discoveryExpectedState.model,'Discovery results, defaults and all old models must survive restart');
 assert.deepEqual((await savedStore('connection-storage')).connections,discoveryExpectedState.connections,'Failure-service configuration must survive restart');
 discoveryVerification.restartPreserved=true;
 assert.deepEqual(await savedStore('project-storage'),legacyDataSnapshot.projects,'Retired project metadata must remain available in backups');
 assert.deepEqual(await savedStore('memory-storage'),legacyDataSnapshot.memories,'Retired memory data must survive without being applied or deleted');
 assert.deepEqual(await savedStore('workflow-storage'),legacyDataSnapshot.workflows,'Retired recipe content and metadata must survive restart');
 const history=await savedStore('chat-storage');assert(history.sessions.some(s=>s.id==='legacy-project-chat'&&s.messages.some(m=>m.id===oldAnswer.id)));assert(history.sessions.some(s=>s.id==='legacy-orphan-chat'));
 assert.equal(await cdp.eval('document.querySelector("nav[aria-label=对话浏览范围]")'),null);
 await verifyTaskEntry('zh');
 const reopened=await cdp.eval('window.electron.runtimeGetState()');assert(reopened.tasks.some(t=>t.id===task.id&&t.status==='completed'));
 assert.equal(errors.length,0,JSON.stringify(errors));
 await quitNormally();
 const screenshots=(await fs.readdir(base)).filter(file=>file.endsWith('.png')).sort();assert.equal(screenshots.length,17);assert(!screenshots.includes('04-workspace.png')&&!screenshots.includes('11-personal-tools.png'),'Retired workbench screenshots must not be reused');
 if(isolatedCredentials)assert.equal(credentialFixtureInstalls,2,'The same isolated fixture must be installed before both launches');
 console.log(JSON.stringify({ok:true,profile:base,credentialStorage:isolatedCredentials?'isolatedEncryptedFixture':'electronSafeStorage',systemKeychainVerified:false,credentialFixtureInstalls,modelRequests:requests.length,modelDiscoveryRequests:discoveryRequests,modelDiscovery:discoveryVerification,layout:layoutVerification,taskId:task.id,steps:task.steps.length,checks:report.checks.map(c=>[c.kind,c.status]),screenshots,legacyConfigOrganized:{services:5,chatModels:5,cliImageUnchanged:true},modelHubDraftRetained:true,projectFeatureRemoved:true,personalAndImageWorkbenchesRemoved:true,retiredMediaEventIgnored:true,legacyHistoryAndMetadataPreserved:true,legacyProjectRulesAndMemoriesIgnored:true,legacyMemoryAndRecipeDataPreserved:true,ordinaryNewChatVerified:true,restartPreserved:true,normalQuitVerified:true,offlineOcrVerified:Boolean(ocrFixture)},null,2));
}catch(error){console.error(error);if(cdp)console.error(await cdp.eval('({text:document.body.innerText,apis:Object.keys(window.electron||{}),root:document.querySelector("#root")?.innerHTML.slice(0,2000)})').catch(()=>null));console.error(errors);console.error(logs.join('').slice(-12000));process.exitCode=1;console.log(`Evidence: ${base}`);}
finally{await stop();server.closeAllConnections();server.close();}
