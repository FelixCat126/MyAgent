import type { FileInfo, KnowledgeEmbedConfig } from '../../types';
import { sessionTask } from '../../features/runtime/taskBridge';
import { runAgentLocalToolBatch, type AgentLocalToolContext } from './localTools';
import { toolCallSignature, type AgentToolCall } from '../parseAgentTools';
import { createAgentCancelledError } from '../browser/agentBrowserController';
function keyFor(signature:string):string{let a=2166136261,b=5381;for(const char of signature){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b,33)^char.charCodeAt(0);}return `tool:${(a>>>0).toString(16)}:${(b>>>0).toString(16)}:${signature.length}`;}
type SavedResult={signature:string;text:string;exportFiles:FileInfo[];attachFiles:FileInfo[]};
export async function executeDurableToolBatch(sessionId:string,calls:AgentToolCall[],ctx:AgentLocalToolContext,embed:KnowledgeEmbedConfig|null,executed:Map<string,string>){
 const task=sessionTask(sessionId);if(!task)return runAgentLocalToolBatch(calls,ctx,embed,executed,{shouldCancel:ctx.shouldCancel});
 const parts:string[]=[];const exportFiles:FileInfo[]=[];const attachFiles:FileInfo[]=[];let skippedDuplicate=0;
 for(const call of calls){
  if(ctx.shouldCancel?.())throw createAgentCancelledError();
  const signature=toolCallSignature(call),key=keyFor(signature),prior=task.steps.find(s=>s.key===key),cached=prior?.result as SavedResult|undefined;
  if(cached && cached.signature!==signature)throw new Error('工具步骤标识冲突，无法安全恢复');
  if(prior?.status==='completed'&&cached){executed.set(signature,cached.text);parts.push(cached.text);exportFiles.push(...cached.exportFiles);attachFiles.push(...cached.attachFiles);skippedDuplicate++;continue;}
  if(call.tool==='mcp_call'&&(prior?.status==='interrupted'||prior?.status==='running'))throw new Error('外部工具执行中断，结果尚未确认。请先在服务端核对该操作，避免重复写入。');
  await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:'running'});
  try{
   const result=await runAgentLocalToolBatch([call],ctx,embed,executed,{shouldCancel:ctx.shouldCancel});
   if(ctx.shouldCancel?.())throw createAgentCancelledError();
   const failed=/(?:^|\n|】)\s*错误：/.test(result.resultText);const saved:SavedResult={signature,text:result.resultText,exportFiles:result.exportFiles,attachFiles:result.attachFiles};
   const updated=await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:failed?(call.tool==='mcp_call'?'interrupted':'failed'):'completed',result:saved,error:failed?result.resultText:undefined});task.steps=updated.steps;
   if(failed)executed.delete(signature);
   parts.push(result.resultText);exportFiles.push(...result.exportFiles);attachFiles.push(...result.attachFiles);skippedDuplicate+=result.skippedDuplicate;
  }catch(error){const updated=await window.electron.runtimeRecordStep({taskId:task.id,key,title:call.tool,status:call.tool==='mcp_call'?'interrupted':'failed',error:error instanceof Error?error.message:String(error)});task.steps=updated.steps;throw error;}
 }
 return {resultText:parts.join('\n\n').slice(0,24000),exportFiles,attachFiles,skippedDuplicate};
}
