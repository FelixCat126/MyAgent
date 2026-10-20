import type { FileInfo, KnowledgeEmbedConfig } from '../../types';
import { sessionTask } from '../../features/runtime/taskBridge';
import { runAgentLocalToolBatch, type AgentLocalToolContext } from './localTools';
import { isToolErrorText, truncateToolResult, type AgentToolCallOutcome } from './toolResult';
import { toolCallSignature, type AgentToolCall } from '../parseAgentTools';
import { createAgentCancelledError } from '../browser/agentBrowserController';
function keyFor(signature:string):string{let a=2166136261,b=5381;for(const char of signature){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b,33)^char.charCodeAt(0);}return `tool:${(a>>>0).toString(16)}:${(b>>>0).toString(16)}:${signature.length}`;}
type SavedResult={signature:string;text:string;exportFiles:FileInfo[];attachFiles:FileInfo[]};
const MAX_BATCH_RESULT_CHARS=24_000;
export async function executeDurableToolBatch(sessionId:string,calls:AgentToolCall[],ctx:AgentLocalToolContext,embed:KnowledgeEmbedConfig|null,executed:Map<string,string>){
 const task=sessionTask(sessionId);if(!task)return runAgentLocalToolBatch(calls,ctx,embed,executed,{shouldCancel:ctx.shouldCancel});
 const parts:string[]=[];const exportFiles:FileInfo[]=[];const attachFiles:FileInfo[]=[];const outcomes:AgentToolCallOutcome[]=[];let skippedDuplicate=0;let notExecuted=0;
 for(const call of calls){
  if(ctx.shouldCancel?.())throw createAgentCancelledError();
  const signature=toolCallSignature(call),key=keyFor(signature),prior=task.steps.find(s=>s.key===key),cached=prior?.result as SavedResult|undefined;
  if(cached && cached.signature!==signature)throw new Error('工具步骤标识冲突，无法安全恢复');
  if(prior?.status==='completed'&&cached){executed.set(signature,cached.text);parts.push(cached.text);outcomes.push({text:truncateToolResult(cached.text),isError:false});exportFiles.push(...cached.exportFiles);attachFiles.push(...cached.attachFiles);skippedDuplicate++;continue;}
  if(call.tool==='mcp_call'&&(prior?.status==='interrupted'||prior?.status==='running')){
   // 结果未确认的外部写入不能自动重放；交给模型说明情况而不是让整轮失败
   const text='【mcp_call】错误：外部工具上次执行中断，结果尚未确认。请先在服务端核对该操作，避免重复写入；不要再次发起相同调用。';
   parts.push(text);outcomes.push({text,isError:true});skippedDuplicate++;continue;
  }
  await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:'running'});
  try{
   const result=await runAgentLocalToolBatch([call],ctx,embed,executed,{shouldCancel:ctx.shouldCancel});
   if(ctx.shouldCancel?.())throw createAgentCancelledError();
   const failed=isToolErrorText(result.resultText);const saved:SavedResult={signature,text:result.resultText,exportFiles:result.exportFiles,attachFiles:result.attachFiles};
   const uncertain=failed&&call.tool==='mcp_call'&&!result.notExecuted;
   const updated=await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:failed?(uncertain?'interrupted':'failed'):'completed',result:saved,error:failed?result.resultText:undefined});task.steps=updated.steps;
   if(failed)executed.delete(signature);
   parts.push(result.resultText);outcomes.push(...(result.outcomes??[{text:truncateToolResult(result.resultText),isError:failed}]));exportFiles.push(...result.exportFiles);attachFiles.push(...result.attachFiles);skippedDuplicate+=result.skippedDuplicate;notExecuted+=result.notExecuted??0;
  }catch(error){const updated=await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:call.tool==='mcp_call'?'interrupted':'failed',error:error instanceof Error?error.message:String(error)});task.steps=updated.steps;throw error;}
 }
 const joined=parts.join('\n\n');
 return {resultText:joined.length>MAX_BATCH_RESULT_CHARS?joined.slice(0,MAX_BATCH_RESULT_CHARS)+'\n\n（工具结果已截断，以上为前部内容）':joined,exportFiles,attachFiles,skippedDuplicate,outcomes,notExecuted};
}
