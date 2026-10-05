import { useChatStore } from '../../store/chatStore';
import { useModelStore } from '../../store/modelStore';
import { useSettingStore } from '../../store/settingStore';
import { useWebSearchStore } from '../../store/webSearchStore';
import {commitUserMessageAndReply,tryClaimSessionSend,type RunModelReplyFn} from '../../chat/sendPipeline';
import {effectiveWebEnabled} from '../../utils/chatModelPolicy';
import {resolveSendModel} from '../../agent/resolveSendModel';
import {getActiveMessages} from '../../utils/branchTree';
import {waitForSessionTaskEnd} from '../personal/runtimeDispatcher';
import type {VoiceQuickAPI,QuickRequest,QuickUpdate} from './api';
export function installQuickChatBridge(options:{runModelReply:RunModelReplyFn;stopSession:(sessionId:string)=>void}):()=>void{
 const api=window.electron as unknown as VoiceQuickAPI;if(!api.onQuickSubmit)return()=>{};
 let quickSessionId:string|undefined;let active:{id:string;sessionId:string;cancelled?:boolean;afterTimestamp:number}|undefined;let mounted=true;let timer:ReturnType<typeof setTimeout>|undefined;
 const update=(payload:QuickUpdate)=>{void api.quickReplyUpdate(payload).catch(error=>console.error('[Quick panel]',error));};
 const publish=()=>{if(!active)return;const session=useChatStore.getState().sessions.find(s=>s.id===active!.sessionId);const messages=getActiveMessages(session?.messages||[],session?.activeLeafId);const answer=[...messages].reverse().find(m=>m.role==='assistant'&&m.timestamp>=active!.afterTimestamp);const busy=useChatStore.getState().isLoadingSession(active.sessionId)||useChatStore.getState().isCompressingSession(active.sessionId);update({id:active.id,status:active.cancelled?'cancelled':busy?'running':'completed',content:answer?.content||'',sessionId:active.sessionId,files:answer?.files?.map(f=>({name:f.name}))});};
 const unsubState=useChatStore.subscribe(()=>{if(!active||timer)return;timer=setTimeout(()=>{timer=undefined;publish();},80);});
 const send=async(request:QuickRequest)=>{
  if(active){update({id:request.id,status:'failed',error:'上一条快捷任务尚未结束'});return;}
  const modelState=useModelStore.getState();const fallback=modelState.getActiveModel();if(!fallback){update({id:request.id,status:'failed',error:'请先在设置中选择默认对话模型'});return;}
  const chat=useChatStore.getState();if(chat.loadingSessionIds.size||chat.compressingSessionIds.size){update({id:request.id,status:'failed',error:'其他对话仍在处理，请等待完成或停止后再发送'});return;}const previousSessionId=chat.currentSessionId;let session=chat.sessions.find(s=>s.id===quickSessionId);
  if(!session){quickSessionId=chat.createSession();session=useChatStore.getState().sessions.find(s=>s.id===quickSessionId);if(previousSessionId)useChatStore.getState().switchSession(previousSessionId);}
  if(!session)return;
  const sessionId=session.id;if(!tryClaimSessionSend(sessionId)){update({id:request.id,status:'failed',sessionId,error:'这个对话仍在处理上一条消息'});return;}
  active={id:request.id,sessionId,afterTimestamp:Date.now()};publish();
  const locale=useSettingStore.getState().locale;const history=getActiveMessages(session.messages,session.activeLeafId);const model=resolveSendModel({models:modelState.models,activeModel:fallback,routingRules:modelState.routingRules,history,userText:request.text,hasImages:false});
  try{
   await commitUserMessageAndReply({sessionId,textContent:request.text,model,locale:locale==='en'?'en':'zh',summaryTitle:locale==='en'?'Conversation summary':'对话摘要',webEnabled:effectiveWebEnabled(session,useWebSearchStore.getState().enabled),attachmentTitle:'附件',newSessionTitle:'快捷对话',runModelReply:options.runModelReply});
   await waitForSessionTaskEnd(sessionId);if(!mounted)return;
   const messages=getActiveMessages(useChatStore.getState().sessions.find(s=>s.id===sessionId)?.messages||[]);const answer=[...messages].reverse().find(m=>m.role==='assistant'&&m.timestamp>=(active?.afterTimestamp||0));
   const failure=answer?.exportHint?.status==='failed'?answer.exportHint.error:answer?.meta?.taskError||(!answer?.content.trim()&&!answer?.files?.length?'未收到有效回答':undefined);
   update({id:request.id,status:active?.cancelled?'cancelled':failure?'failed':'completed',content:answer?.content||'',sessionId,files:answer?.files?.map(f=>({name:f.name})),error:failure});
  }catch(error){chat.clearLoadingForSession(sessionId);update({id:request.id,status:'failed',sessionId,error:error instanceof Error?error.message:String(error)});}
  finally{active=undefined;if(timer){clearTimeout(timer);timer=undefined;}}
 };
 const offSubmit=api.onQuickSubmit(request=>void send(request));
 const offCancel=api.onQuickCancel(id=>{if(active?.id===id){active.cancelled=true;const sessionId=active.sessionId;options.stopSession(sessionId);update({id,status:'cancelled',sessionId});}});
 const offOpen=api.onQuickOpenSession(sessionId=>{if(useChatStore.getState().sessions.some(s=>s.id===sessionId))useChatStore.getState().switchSession(sessionId);});
 return()=>{mounted=false;if(timer)clearTimeout(timer);offSubmit();offCancel();offOpen();unsubState();};
}
