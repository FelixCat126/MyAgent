// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { NativeModelAccumulator, openAiAgentMessages, anthropicAgentMessages } from './nativeModelProtocol';
import type { Message } from '../../src/types';
describe('native model protocol',()=>{
  it('joins fragmented function arguments and preserves IDs',()=>{
    const acc=new NativeModelAccumulator();
    acc.feed({choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'local_read',arguments:'{"pa'}}]}}]});
    acc.feed({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'th":"/tmp/a"}'}}]}}]});
    expect(acc.finish().toolCalls).toEqual([{id:'call1',name:'local_read',arguments:{path:'/tmp/a'}}]);
  });
  it('rejects malformed arguments before execution',()=>{
    const acc=new NativeModelAccumulator();
    acc.feed({choices:[{message:{tool_calls:[{id:'x',function:{name:'local_read',arguments:'{"'}}]}}]});
    expect(()=>acc.finish()).toThrow('JSON');
  });
  it('round trips both protocols with native tool results',()=>{
    const messages:Message[]=[{id:'1',role:'assistant',content:'',timestamp:1,model:'test',nativeToolCalls:[{id:'call1',name:'local_read',arguments:{path:'/a'}}]},
      {id:'2',role:'system',content:'text',timestamp:1,model:'test',nativeToolResults:[{id:'call1',content:'source'}]}];
    expect(openAiAgentMessages(messages)[1]).toMatchObject({role:'tool',tool_call_id:'call1'});
    expect(anthropicAgentMessages(messages).messages[1]).toMatchObject({role:'user',content:[{type:'tool_result',tool_use_id:'call1'}]});
  });
  it('streams Anthropic thinking before complete tool JSON',()=>{
    const thinking:string[]=[]; const acc=new NativeModelAccumulator(t=>thinking.push(t));
    acc.feed({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'t1',name:'local_read',input:{}}});
    acc.feed({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":"/a"}'}});
    acc.feed({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'reason'}});
    expect(acc.finish().toolCalls?.[0].arguments).toEqual({path:'/a'}); expect(thinking).toEqual(['reason']);
  });
});
