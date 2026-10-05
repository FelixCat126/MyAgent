import { BrowserWindow, ipcMain, globalShortcut } from 'electron';
import {randomUUID} from 'node:crypto';
import type { QuickUpdate } from '../src/features/voiceQuick/api';
let quickWindow:BrowserWindow|null=null;
let activeRequest:string|undefined;
let lastUpdate:QuickUpdate|undefined;
let shortcutRegistered=false;
let firstUpdateTimer:ReturnType<typeof setTimeout>|undefined;
function publishQuick(update:QuickUpdate):void{if(quickWindow&&!quickWindow.isDestroyed())quickWindow.webContents.send('quick-panel-update',update);}
const shortcut='CommandOrControl+Shift+Space';
const quickHtml=String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{display:flex;flex-direction:column;margin:0;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;background:#111827}header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 10px;-webkit-app-region:drag}h1{font-size:16px;margin:0;color:#f8fafc}small{color:#94a3b8;font-size:11px}button{border:1px solid #334155;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:7px 12px;cursor:pointer;-webkit-app-region:no-drag}button:hover{border-color:#64748b}button:disabled{opacity:.4;cursor:default}main{padding:10px 22px 18px;flex:1;min-height:0;display:flex;flex-direction:column}textarea{width:100%;height:86px;flex-shrink:0;resize:none;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:13px;color:#f8fafc;font:inherit;font-size:15px;outline:none}textarea:focus{border-color:#14b8a6}.toolbar{display:flex;align-items:center;gap:8px;margin-top:10px}.toolbar span{flex:1;color:#94a3b8;font-size:12px}#send{background:#0f766e;border-color:#0d9488}#preview{flex:1;min-height:80px;overflow:auto;margin-top:18px;line-height:1.7;white-space:pre-wrap;border-top:1px solid #273447;padding-top:16px}#files{flex-shrink:0;font-size:12px;color:#94a3b8;margin-top:8px}#error{color:#fca5a5;font-size:12px;margin-top:8px}footer{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;margin-top:12px}kbd{font:inherit;font-size:10px;border:1px solid #334155;border-radius:4px;padding:1px 4px}#stop{display:none;color:#fca5a5}
</style></head><body><header><h1>MyAgent · 快捷对话</h1><button id="close" aria-label="隐藏快捷窗口">×</button></header><main><textarea id="input" placeholder="随手问一句，或交给助手做件事…" aria-label="快捷对话输入"></textarea><div class="toolbar"><span id="status">使用当前默认模型 · 内容保存在正常会话中</span><button id="stop">停止</button><button id="send">发送 ↵</button></div><div id="error" role="alert"></div><div id="preview" aria-live="polite">按 Enter 发送，Shift + Enter 换行。</div><div id="files"></div><footer><small><kbd>Esc</kbd> 隐藏 · <kbd>⌘/Ctrl ⇧ Space</kbd> 随时唤起</small><button id="open" disabled>打开完整对话</button></footer></main><script>
const api=window.quickAgent,input=document.getElementById('input'),send=document.getElementById('send'),stop=document.getElementById('stop'),preview=document.getElementById('preview'),status=document.getElementById('status'),error=document.getElementById('error'),files=document.getElementById('files'),open=document.getElementById('open');let id='',sessionId='',running=false;
function busy(value){running=value;send.disabled=value;stop.style.display=value?'inline-block':'none'}
async function submit(){const text=input.value.trim();if(!text||running)return;error.textContent='';preview.textContent='';files.textContent='';open.disabled=true;sessionId='';busy(true);status.textContent='正在处理…';try{const result=await api.send(text);id=result.id;if(result.error){error.textContent=result.error;busy(false);status.textContent='发送失败';}}catch(e){error.textContent=e.message||String(e);busy(false);status.textContent='发送失败'}}
send.onclick=submit;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit()}};document.onkeydown=e=>{if(e.key==='Escape')api.hide()};document.getElementById('close').onclick=()=>api.hide();stop.onclick=()=>{if(id)api.cancel(id)};open.onclick=()=>{if(sessionId)api.open(sessionId)};
api.onFocus(()=>input.focus());api.onUpdate(update=>{id=update.id;sessionId=update.sessionId||sessionId;preview.textContent=update.content||preview.textContent;files.textContent=(update.files||[]).map(f=>'附件：'+f.name).join(' · ');open.disabled=!sessionId;error.textContent=update.error||'';busy(update.status==='running');status.textContent=({running:'正在处理…',completed:'已完成',failed:'执行失败',cancelled:'已停止'})[update.status];if(!running)input.focus();preview.scrollTop=preview.scrollHeight;});input.focus();
</script></body></html>`;
function quickDocument(locale:string):string{if(locale!=='en')return quickHtml;const phrases:Record<string,string>={'MyAgent · 快捷对话':'MyAgent · Quick chat','隐藏快捷窗口':'Hide quick chat','随手问一句，或交给助手做件事…':'Ask a question or give the assistant a task…','快捷对话输入':'Quick chat input','使用当前默认模型 · 内容保存在正常会话中':'Current default model · Saved in normal chat history','发送 ↵':'Send ↵','按 Enter 发送，Shift + Enter 换行。':'Enter to send, Shift + Enter for a new line.','打开完整对话':'Open full chat','正在处理…':'Working…','发送失败':'Send failed','已完成':'Completed','执行失败':'Failed','已停止':'Stopped','附件：':'File: ','停止':'Stop','隐藏':'Hide','随时唤起':'Open any time'};let html=quickHtml.replace('lang="zh-CN"','lang="en"');for(const[zh,en]of Object.entries(phrases))html=html.split(zh).join(en);return html;}
export function registerQuickWindow(options:{preloadPath:string;getMainWindow:()=>BrowserWindow|null;getLocale?:()=>string}):void{
 const main=()=>{const window=options.getMainWindow();return window&&!window.isDestroyed()?window:null;};
 const show=()=>{
  if(quickWindow&&!quickWindow.isDestroyed()){quickWindow.show();quickWindow.focus();quickWindow.webContents.send('quick-panel-focus');return;}
  quickWindow=new BrowserWindow({width:680,height:540,minWidth:560,minHeight:500,resizable:false,frame:false,show:false,alwaysOnTop:true,skipTaskbar:true,title:'MyAgent 快捷对话',backgroundColor:'#111827',webPreferences:{preload:options.preloadPath,nodeIntegration:false,contextIsolation:false,sandbox:false}});
  quickWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));quickWindow.webContents.on('will-navigate',event=>event.preventDefault());
  quickWindow.on('closed',()=>{quickWindow=null;});
  quickWindow.webContents.once('did-finish-load',()=>{quickWindow?.show();quickWindow?.focus();if(lastUpdate)publishQuick(lastUpdate);});
  void quickWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(quickDocument(options.getLocale?.()||'zh'))}`);
 };
 ipcMain.handle('quick-panel-show',()=>{show();return{available:true};});
 ipcMain.handle('quick-panel-send',(event,text:unknown)=>{
  if(event.sender.id!==quickWindow?.webContents.id)throw new Error('快捷窗口来源无效');
  if(typeof text!=='string'||!text.trim()||text.length>32000)throw new Error('请输入 1 到 32000 字的内容');
  const id=randomUUID();const target=main();if(!target)return{id,error:'主对话窗口尚未就绪，请先打开 MyAgent'};
  if(activeRequest&&lastUpdate?.status==='running')return{id,error:'上一条快捷对话仍在处理，请停止后再发送'};
  activeRequest=id;lastUpdate={id,status:'running'};if(firstUpdateTimer)clearTimeout(firstUpdateTimer);firstUpdateTimer=setTimeout(()=>{if(activeRequest===id&&lastUpdate?.status==='running'){lastUpdate={id,status:'failed',error:'主对话尚未响应，请打开主窗口后重试'};publishQuick(lastUpdate);target.webContents.send('quick-panel-cancel',id);}},20_000);target.webContents.send('quick-panel-submit',{id,text:text.trim()});return{id};
 });
 ipcMain.handle('quick-panel-update',(event,update:QuickUpdate)=>{
  if(event.sender.id!==main()?.webContents.id)throw new Error('回复来源无效');
  if(update.id!==activeRequest)return;if(firstUpdateTimer){clearTimeout(firstUpdateTimer);firstUpdateTimer=undefined;}lastUpdate={...update,content:update.content?.slice(0,120000),error:update.error?.slice(0,2000)};publishQuick(lastUpdate);
 });
 ipcMain.handle('quick-panel-cancel',(event,id:string)=>{if(event.sender.id!==quickWindow?.webContents.id)return;if(id===activeRequest)main()?.webContents.send('quick-panel-cancel',id);});
 ipcMain.handle('quick-panel-hide',event=>{if(event.sender.id===quickWindow?.webContents.id)quickWindow?.hide();});
 ipcMain.handle('quick-panel-open',(event,sessionId:string)=>{if(event.sender.id!==quickWindow?.webContents.id||sessionId!==lastUpdate?.sessionId)return;const target=main();target?.show();target?.focus();target?.webContents.send('quick-panel-open-session',sessionId);quickWindow?.hide();});
 shortcutRegistered=globalShortcut.register(shortcut,show);
 if(!shortcutRegistered)console.warn('[MyAgent] 快捷窗口热键被占用，可从应用内按钮打开');
}
export function shutdownQuickWindow():void{if(firstUpdateTimer)clearTimeout(firstUpdateTimer);if(shortcutRegistered)globalShortcut.unregister(shortcut);quickWindow?.destroy();quickWindow=null;activeRequest=undefined;lastUpdate=undefined;}
