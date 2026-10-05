import { useChatStore } from '../../store/chatStore';
import type { RuntimeTask } from './api';
import type { Message } from '../../types';

const sessionTasks = new Map<string, RuntimeTask>();
const pending = new Map<string, Promise<void>>();
const cancelled = new Set<string>();
export function sessionTask(sessionId: string): RuntimeTask | undefined { return sessionTasks.get(sessionId); }
export function bindSessionTask(sessionId: string, task: RuntimeTask): void { sessionTasks.set(sessionId,task); cancelled.delete(sessionId); }
export async function createSessionTask(sessionId: string, userMessage: Message, options?:{occurrenceId?:string}): Promise<void> {
  if (!window.electron?.runtimeCreateTask || sessionTasks.has(sessionId)) return;
  if(pending.has(sessionId))return pending.get(sessionId);
  cancelled.delete(sessionId);
  const creating=(async()=>{
    const task=await window.electron.runtimeCreateTask({title:userMessage.content.slice(0,80)||userMessage.files?.[0]?.name||'对话任务',kind:'agent',prompt:userMessage.content,idempotencyKey:`message:${sessionId}:${userMessage.id}:${userMessage.timestamp}${options?.occurrenceId?`:${options.occurrenceId}`:''}`,checkpoint:{sessionId,userMessageId:userMessage.id,modelId:userMessage.model,foreground:true}});
    if(cancelled.has(sessionId)){await window.electron.runtimeCancelTask(task.id);return;}
    const running=task.status==='queued'?await window.electron.runtimeClaimTask(task.id):task;
    if(cancelled.has(sessionId)){await window.electron.runtimeCancelTask(task.id);return;}
    bindSessionTask(sessionId,running);
  })();
  pending.set(sessionId,creating);
  try{await creating;}finally{if(pending.get(sessionId)===creating)pending.delete(sessionId);}
}
export async function saveSessionCheckpoint(sessionId:string, checkpoint:Record<string,unknown>):Promise<void> {
  const task=sessionTasks.get(sessionId); if(!task)return;
  task.checkpoint={...task.checkpoint,...checkpoint};
  await window.electron.runtimeSaveCheckpoint({id:task.id,checkpoint:task.checkpoint});
}
export async function finishSessionTask(sessionId:string):Promise<void> {
  if(pending.has(sessionId))await pending.get(sessionId);
  const task=sessionTasks.get(sessionId);if(!task)return;
  sessionTasks.delete(sessionId);
  const session=useChatStore.getState().sessions.find(s=>s.id===sessionId);
  const userIndex=session?.messages.findIndex(m=>m.id===task.checkpoint?.userMessageId)??-1;
  const answer=userIndex>=0?session?.messages.slice(userIndex+1).filter(m=>m.role==='assistant'&&m.timestamp>=task.createdAt).at(-1):undefined;
  const error=answer?.exportHint?.status==='failed'?answer.exportHint.error||'文件生成失败':answer?.meta?.taskError||(!answer||(!answer.content.trim()&&!answer.files?.length)?'未收到有效回答，任务未完成':undefined);
  try { await window.electron.runtimeCompleteTask({id:task.id,result:answer?{content:answer.content,files:answer.files,sessionId,messageId:answer.id}:undefined,error}); }
  catch (error) { console.error('[Task completion]',error instanceof Error?error.message:'Failed'); }
}
export async function cancelSessionTask(sessionId:string):Promise<void> {
  cancelled.add(sessionId);
  if(pending.has(sessionId))await pending.get(sessionId);
  const task=sessionTasks.get(sessionId);if(!task)return;
  sessionTasks.delete(sessionId);await window.electron.runtimeCancelTask(task.id);
}
