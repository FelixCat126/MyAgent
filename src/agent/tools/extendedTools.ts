import type { AgentLocalToolContext } from './localTools';
import type { AgentToolCall } from '../parseAgentTools';
import type { FileInfo } from '../../types';
import type { McpCallResult } from '../../features/runtime/api';
import { createAgentCancelledError } from '../browser/agentBrowserController';
/** 批准已过期后，主进程仍在执行时的额外等待上限（主进程单次调用超时 30 秒） */
const APPROVED_CALL_GRACE_MS = 40_000;
/** notExecuted：外部工具确定未执行（拒绝、超时未批准、调用前失败），可安全重试 */
export async function executeExtendedTool(call:AgentToolCall,shouldCancel?:()=>boolean,ctx?:AgentLocalToolContext):Promise<{text:string;files:FileInfo[];notExecuted?:boolean}> {
 if(call.tool==='data_calculate'){
  const requestId=crypto.randomUUID();const poll=window.setInterval(()=>{if(shouldCancel?.())window.electron.cancelDocumentOperation(requestId);},100);
  try{const result=await window.electron.calculateDocumentData({...call.calculation,requestId,scope:ctx?{scoped:ctx.scopeRoot!==undefined,root:ctx.scopeRoot,deniedPaths:ctx.deniedPaths,attachmentPaths:ctx.attachmentPaths}:undefined});if(!result.ok)return {text:`错误：${result.error}`,files:[]};return {text:JSON.stringify({source:result.result.source,columns:result.result.columns,rows:result.result.rows.slice(0,200),totalRows:result.result.rows.length,warnings:result.result.warnings,files:result.result.files}),files:result.result.files};}finally{window.clearInterval(poll);}
 }
 if(call.tool==='mcp_call'){
  const callId=`agent:${crypto.randomUUID()}`;
  let response:McpCallResult;
  const directPoll=window.setInterval(()=>{if(shouldCancel?.())void window.electron.runtimeCancelMcpCall(callId);},100);
  try{response=await window.electron.runtimeCallTool({connectionId:call.connectionId,tool:call.name,args:call.args,callId});}
  catch(error){if(shouldCancel?.())throw createAgentCancelledError();return {text:`错误：${error instanceof Error?error.message:String(error)}`,files:[],notExecuted:true};}
  finally{window.clearInterval(directPoll);}
  if(shouldCancel?.())throw createAgentCancelledError();
  if(response.authorizationRequired){
   const approval=response.authorizationRequired;
   window.dispatchEvent(new CustomEvent('myagent-runtime-approval-needed',{detail:approval}));
   response=await new Promise<McpCallResult>((resolve,reject)=>{
    let done=false;let unsubscribe=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;let grace:ReturnType<typeof setTimeout>|undefined;let poll:ReturnType<typeof setInterval>;
    const finish=(fn:()=>void)=>{if(done)return;done=true;unsubscribe();clearTimeout(timer);clearTimeout(grace);clearInterval(poll);fn();};
    unsubscribe=window.electron.onRuntimeMcpResult(event=>{if(event.approvalId===approval.id)finish(()=>resolve(event.result));});
    // 到期后先确认主进程是否已批准并在执行，避免把已发生的写入误报为超时
    timer=setTimeout(()=>{void window.electron.runtimeGetState().then(state=>{
     if(done)return;
     if(state.executingMcpCalls?.includes(approval.id)){grace=setTimeout(()=>finish(()=>resolve({error:'外部工具执行结果未返回，结果尚未确认'})),APPROVED_CALL_GRACE_MS);return;}
     void window.electron.runtimeCancelMcpCall(approval.id);
     finish(()=>resolve({error:'外部工具等待批准超时，请重新请求',rejected:true}));
    }).catch(()=>finish(()=>resolve({error:'外部工具等待批准超时，请重新请求',rejected:true})));},Math.max(1,approval.expiresAt-Date.now()+1000));
    poll=setInterval(()=>{if(shouldCancel?.()){void window.electron.runtimeCancelMcpCall(approval.id);finish(()=>reject(createAgentCancelledError()));}},100);
   });
  }
  return {text:response.error?`错误：${response.error}`:JSON.stringify(response.result),files:[],notExecuted:Boolean(response.error&&response.rejected)};
 }
 throw new Error('Unknown extended tool');
}
