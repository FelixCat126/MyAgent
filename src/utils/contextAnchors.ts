import type { Message } from '../types';
import { withoutGeneratedRuntimeContext } from './runtimeContext';
/** Exact excerpts protect decisions and numeric values when a model summary omits them. */
export function extractContextAnchors(messages:Message[],maxChars=2800):string {
 const candidates:Array<{text:string;priority:number;index:number}>=[];
 withoutGeneratedRuntimeContext(messages).forEach((message,index)=>{
  if(message.meta?.kind==='context-summary'){candidates.push({text:message.content,priority:2,index});return;}
  for(const line of message.content.split(/\n|(?<=[。！？])\s*/)){
   if(!line.trim())continue;
   const decision=/(决定|确认|要求|必须|不要|以后|待办|未完成|同意|决定|deadline|decid|agreed|must|prefer|todo)/i.test(line);
   const matches=[...line.matchAll(/(?:\b\d+(?:[.,]\d+)*(?:\s*[%¥$€元万亿年月日时分秒kgkmcmMBGB]|\b)|https?:\/\/[^\s<>]+|[\w\u4e00-\u9fff-]+\.(?:xlsx|docx|pdf|csv|png|jpg|md)\b)/gi)];
   if(!decision&&!matches.length)continue;
   const text=line.length<=300?line:decision?line.slice(0,300):matches.map(match=>line.slice(Math.max(0,(match.index??0)-65),Math.min(line.length,(match.index??0)+match[0].length+65))).slice(0,4).join(' … ');
   candidates.push({text:`[${message.role} ${message.id}] ${text.trim()}`,priority:(decision?4:2)+(message.role==='user'?2:0),index});
  }
 });
 const seen=new Set<string>();const selected:Array<{text:string;index:number}>=[];let used=0;
 for(const entry of candidates.sort((a,b)=>b.priority-a.priority||b.index-a.index)){
  if(seen.has(entry.text)||used+entry.text.length+1>maxChars)continue;
  selected.push(entry);used+=entry.text.length+1;seen.add(entry.text);if(selected.length>=24)break;
 }
 return selected.sort((a,b)=>a.index-b.index).map(entry=>entry.text).join('\n');
}
