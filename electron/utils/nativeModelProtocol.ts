import type { Message } from '../../src/types';
import type { NativeToolCall, NativeToolDefinition, ModelRoundResult } from '../../src/features/connections/api';
import { formatAnthropicMessages, formatOpenAIMultimodal } from '../ipc/openai-adapters';

export function openAiAgentMessages(messages: Message[], preserveReasoning = false): Array<Record<string, unknown>> {
  return messages.flatMap<Record<string, unknown>>((message) => {
    if (message.nativeToolResults?.length) return message.nativeToolResults.map(result => ({ role:'tool',tool_call_id:result.id,content:result.content }));
    const plain = formatOpenAIMultimodal([message])[0] as Record<string, unknown>;
    if (!message.nativeToolCalls?.length) return [plain];
    return [{...plain, ...(preserveReasoning && message.reasoning ? {reasoning_content:message.reasoning}:{}), content:message.content || null, tool_calls:message.nativeToolCalls.map(call => ({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}];
  });
}
export function anthropicAgentMessages(messages: Message[]): ReturnType<typeof formatAnthropicMessages> {
  const formatted = formatAnthropicMessages(messages.filter(message => !message.nativeToolResults?.length));
  const conversation: typeof formatted.messages = [];
  for (const message of messages) {
    if (message.role === 'system' && !message.nativeToolResults?.length) continue;
    if (message.nativeToolResults?.length) {
      conversation.push({role:'user',content:message.nativeToolResults.map(result => ({type:'tool_result',tool_use_id:result.id,content:result.content,...(result.isError ? {is_error:true}: {})}))});
    } else if (message.nativeAssistantBlocks?.length) {
      conversation.push({role:'assistant',content:message.nativeAssistantBlocks});
    } else if (message.nativeToolCalls?.length) {
      const blocks: Array<Record<string,unknown>> = message.content ? [{type:'text',text:message.content}] : [];
      blocks.push(...message.nativeToolCalls.map(call => ({type:'tool_use',id:call.id,name:call.name,input:call.arguments})));
      conversation.push({role:'assistant',content:blocks});
    } else {
      conversation.push(...formatAnthropicMessages([message]).messages);
    }
  }
  return {system:formatted.system,messages:conversation};
}
export function nativeToolPayload(tools: NativeToolDefinition[], anthropic: boolean): unknown[] {
  return tools.map(tool => anthropic ? {name:tool.name,description:tool.description,input_schema:tool.parameters}
    : {type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}});
}
type PendingTool = {id:string;name:string;json:string;input?:Record<string,unknown>};
export class NativeModelAccumulator {
  content = '';
  reasoning = '';
  private blocks = new Map<number,Record<string,unknown>>();
  private pending = new Map<number,PendingTool>();
  constructor(private readonly onThinking?: (text:string)=>void) {}
  feed(data: Record<string, unknown>): void {
    if (data.type === 'error' || data.error) throw new Error('模型返回了流式错误 / Provider returned a stream error');
    const index = typeof data.index === 'number' ? data.index : 0;
    if (data.type === 'content_block_start') {
      const block = data.content_block as Record<string,unknown> | undefined;
      if (block) this.blocks.set(index,{...block});
      if (block?.type === 'tool_use') this.pending.set(index,{id:String(block.id || ''),name:String(block.name || ''),json:'',input:block.input as Record<string,unknown>});
      else if (block?.type === 'text' && typeof block.text === 'string') this.content += block.text;
      return;
    }
    if (data.type === 'content_block_delta') {
      const delta = data.delta as Record<string,unknown>;
      const block=this.blocks.get(index);
      if(block && delta.type==='text_delta') block.text=String(block.text||'')+String(delta.text||'');
      if(block && delta.type==='thinking_delta') block.thinking=String(block.thinking||'')+String(delta.thinking||'');
      if(block && delta.type==='signature_delta') block.signature=String(block.signature||'')+String(delta.signature||'');
      if (delta.type === 'text_delta') this.content += String(delta.text ?? '');
      if (delta.type === 'thinking_delta') this.addThinking(String(delta.thinking ?? ''));
      if (delta.type === 'input_json_delta') {
        const tool = this.pending.get(index);
        if (tool) tool.json += String(delta.partial_json ?? '');
      }
      return;
    }
    const choices = data.choices as Array<{delta?:Record<string,unknown>;message?:Record<string,unknown>}> | undefined;
    const message = choices?.[0]?.delta ?? choices?.[0]?.message;
    if (!message) return;
    if (typeof message.content === 'string') this.content += message.content;
    const thinking = message.reasoning_content ?? message.reasoning ?? message.thinking;
    if (typeof thinking === 'string') this.addThinking(thinking);
    if (Array.isArray(message.tool_calls)) for (const [position,item] of message.tool_calls.entries()) {
      const block = item as {index?:number;id?:string;function?:{name?:string;arguments?:string}};
      const idx = block.index ?? position;
      const previous = this.pending.get(idx) ?? {id:'',name:'',json:''};
      if (block.id) previous.id = block.id;
      if (block.function?.name) previous.name += block.function.name;
      previous.json += block.function?.arguments ?? '';
      this.pending.set(idx,previous);
    }
  }
  addThinking(text:string):void { this.reasoning += text; if(text) this.onThinking?.(text); }
  finish(): ModelRoundResult {
    const calls: NativeToolCall[] = [];
    for (const pending of this.pending.values()) {
      if (!pending.id || !/^[A-Za-z0-9_-]{1,64}$/.test(pending.name)) throw new Error('模型工具调用缺少有效 ID 或名称');
      let args: unknown;
      try { args = pending.json.trim() ? JSON.parse(pending.json) : pending.input ?? {}; }
      catch { throw new Error(`工具 ${pending.name} 返回了不完整的 JSON 参数`); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
      calls.push({id:pending.id,name:pending.name,arguments:args as Record<string,unknown>});
    }
    const assistantBlocks=[...this.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([index,block])=>block.type==='tool_use'?{...block,input:calls.find(call=>call.id===this.pending.get(index)?.id)?.arguments||{}}:block);
    return {assistantBlocks:assistantBlocks.length?assistantBlocks:undefined,content:this.content.trim(),reasoning:this.reasoning.trim() || undefined,toolCalls:calls.length ? calls:undefined,nativeTools:true};
  }
}
