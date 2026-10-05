import type { AgentLocalToolContext } from './localTools';
import type { AgentToolCall } from '../parseAgentTools';
import type { FileInfo } from '../../types';
import type { McpCallResult } from '../../features/runtime/api';
import { createAgentCancelledError } from '../browser/agentBrowserController';
export async function executeExtendedTool(call:AgentToolCall,shouldCancel?:()=>boolean,ctx?:AgentLocalToolContext):Promise<{text:string;files:FileInfo[]}> {
 if(call.tool==='data_calculate'){
  const requestId=crypto.randomUUID();const poll=window.setInterval(()=>{if(shouldCancel?.())window.electron.cancelDocumentOperation(requestId);},100);
  try{const result=await window.electron.calculateDocumentData({...call.calculation,requestId,scope:ctx?{scoped:ctx.scopeRoot!==undefined,root:ctx.scopeRoot,deniedPaths:ctx.deniedPaths,attachmentPaths:ctx.attachmentPaths}:undefined});if(!result.ok)return {text:`错误：${result.error}`,files:[]};return {text:JSON.stringify({source:result.result.source,columns:result.result.columns,rows:result.result.rows.slice(0,200),totalRows:result.result.rows.length,warnings:result.result.warnings,files:result.result.files}),files:result.result.files};}finally{window.clearInterval(poll);}
 }
 if(call.tool==='mcp_call'){
  let response=await window.electron.runtimeCallTool({connectionId:call.connectionId,tool:call.name,args:call.args});
  if(response.authorizationRequired){
   const approval=response.authorizationRequired;
   window.dispatchEvent(new CustomEvent('myagent-runtime-approval-needed',{detail:approval}));
   response=await new Promise<McpCallResult>((resolve,reject)=>{
    let done=false;let unsubscribe=()=>{};let timer:ReturnType<typeof setTimeout>;let poll:ReturnType<typeof setInterval>;
    const finish=(fn:()=>void)=>{if(done)return;done=true;unsubscribe();clearTimeout(timer);clearInterval(poll);fn();};
    unsubscribe=window.electron.onRuntimeMcpResult(event=>{if(event.approvalId===approval.id)finish(()=>resolve(event.result));});
    timer=setTimeout(()=>finish(()=>resolve({error:'外部工具等待批准超时，请重新请求'})),Math.max(1,approval.expiresAt-Date.now()));
    poll=setInterval(()=>{if(shouldCancel?.()){void window.electron.runtimeCancelMcpCall(approval.id);finish(()=>reject(createAgentCancelledError()));}},100);
   });
  }
  return {text:response.error?`错误：${response.error}`:JSON.stringify(response.result),files:[]};
 }
 throw new Error('Unknown extended tool');
}
