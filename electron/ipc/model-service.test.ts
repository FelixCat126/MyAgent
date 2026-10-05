// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import axios from 'axios';
import type { AddressInfo } from 'node:net';
import type { Message, ModelConfig } from '../../src/types';
vi.mock('electron',()=>({ipcMain:{handle:vi.fn(),on:vi.fn()}}));
import { requestNativeModelRound, diagnoseModel, discoverServiceModels, resolveModelDiscoveryUrl } from './model-service';
let server:http.Server;let config:ModelConfig;const bodies:Record<string,unknown>[]=[];
let respond:(body:Record<string,unknown>,response:http.ServerResponse)=>void;
const getRequests:Array<{url:string;headers:http.IncomingHttpHeaders}>=[];
let respondGet:(request:http.IncomingMessage,response:http.ServerResponse)=>void;
beforeEach(async()=>{vi.restoreAllMocks();bodies.length=0;getRequests.length=0;respondGet=(_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({object:'list',data:[{id:'mimo-fixture'}]}));};respond=(body,response)=>{response.setHeader('Content-Type','application/json');const messages=body.messages as Message[];const content=messages.at(-1)?.content?.includes('exact code')?'MYAGENT_HISTORY':'OK';response.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));};server=http.createServer(async(request,response)=>{if(request.method==='GET'){getRequests.push({url:request.url||'',headers:request.headers});respondGet(request,response);return;}let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);bodies.push(body);respond(body,response);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));config={id:'fixture',name:'fixture',provider:'openai',apiUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,apiKey:'fixture-not-a-real-key',modelName:'fixture',maxTokens:2048,isLocal:true,chatApiMode:'openai'};});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const message:Message={id:'u',role:'user',content:'find file',timestamp:1,model:'fixture'};
const tool={name:'local_read',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}};
describe('actual HTTP model service',()=>{
 it('reads fragmented SSE tool arguments and terminates without waiting for keep-alive closure',async()=>{
  respond=(_body,response)=>{response.setHeader('Content-Type','text/event-stream');response.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'local_read',arguments:'{"path":'}}]}}]})+'\n\n');response.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"fixture.md"}'}}]},finish_reason:'tool_calls'}]})+'\n\n');};
  const result=await requestNativeModelRound({config,messages:[message],tools:[tool]});expect(result.toolCalls).toEqual([{id:'call-1',name:'local_read',arguments:{path:'fixture.md'}}]);expect(bodies[0].tools).toBeDefined();
 });
 it('returns actual independent history and tool failures instead of treating any HTTP 200 as success',async()=>{
  const report=await diagnoseModel(config,['chat','history','tools']);expect(report.checks.map(c=>[c.kind,c.status])).toEqual([['chat','verified'],['history','verified'],['tools','failed']]);
 });
 it('round-trips Anthropic tool_use/tool_result and thinking signatures',async()=>{
  config.chatApiMode='anthropic';
  respond=(_body,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({content:[{type:'thinking',thinking:'reason',signature:'signed-fixture'},{type:'tool_use',id:'t1',name:'local_read',input:{path:'a.md'}}]}));};
  const result=await requestNativeModelRound({config,messages:[message],tools:[tool],stream:false});expect(result.assistantBlocks?.[0].signature).toBe('signed-fixture');
  await requestNativeModelRound({config,messages:[message,{...message,id:'a',role:'assistant',content:'',nativeToolCalls:result.toolCalls,nativeAssistantBlocks:result.assistantBlocks},{...message,id:'r',role:'system',content:'FILE TEXT',nativeToolResults:[{id:'t1',content:'FILE TEXT'}]}],tools:[tool],stream:false});
  const sent=bodies[1].messages as Array<{content:unknown[]}>;expect(sent[1].content[0]).toMatchObject({type:'thinking',signature:'signed-fixture'});expect(sent[2].content[0]).toMatchObject({type:'tool_result',tool_use_id:'t1',content:'FILE TEXT'});expect(bodies[1].system).toBeUndefined();
 });
 it('honors cancellation during a connected stream',async()=>{
  respond=(_body,response)=>{response.setHeader('Content-Type','text/event-stream');response.write(': heartbeat\n\n');};const controller=new AbortController();const operation=requestNativeModelRound({config,messages:[message],tools:[tool],signal:controller.signal});const rejection=expect(operation).rejects.toThrow();await new Promise(resolve=>setTimeout(resolve,30));controller.abort();await rejection;
 });
});

describe('actual HTTP model discovery',()=>{
 it('lists OpenAI model IDs rather than display names and handles a full completion URL with query parameters',async()=>{
  config.apiUrl+='/chat/completions?api-version=fixture';
  respondGet=(_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[null,'invalid',{}, {id:'mimo-v2-flash',name:'Human display name'}, {id:'mimo-v2-flash'}, {id:'  another-model  '}, {id:'invalid\nmodel'}]}));};
  const result=await discoverServiceModels(config);expect(result).toEqual({models:[{id:'mimo-v2-flash'},{id:'another-model'}]});expect(getRequests[0].url).toBe('/v1/models?api-version=fixture');expect(getRequests[0].headers.authorization).toBe(`Bearer ${config.apiKey}`);expect(config.apiUrl).toContain('/chat/completions?');
 });
 it.each(['openai','anthropic'] as const)('uses MiMo official /v1/models and api-key authentication for %s chat over real HTTP',async(protocol)=>{
  const port=(server.address() as AddressInfo).port;
  const agent=new http.Agent({lookup:(_hostname,options,callback)=>{if(typeof options==='object'&&options.all)(callback as unknown as (error:null,addresses:Array<{address:string;family:number}>)=>void)(null,[{address:'127.0.0.1',family:4}]);else callback(null,'127.0.0.1',4);}});
  const fixtureClient=axios.create({httpAgent:agent,proxy:false});vi.spyOn(axios,'get').mockImplementation((url,options)=>fixtureClient.get(url,options));
  config={...config,provider:'custom',chatApiMode:protocol,apiUrl:`http://api.xiaomimimo.com:${port}${protocol==='anthropic'?'/anthropic/v1/messages':'/v1/chat/completions'}`};
  try{expect(await discoverServiceModels(config)).toEqual({models:[{id:'mimo-fixture'}]});expect(getRequests[0].url).toBe('/v1/models');expect(getRequests[0].headers['api-key']).toBe(config.apiKey);expect(getRequests[0].headers.host).toBe(`api.xiaomimimo.com:${port}`);expect(getRequests[0].headers.authorization).toBeUndefined();}finally{agent.destroy();}
 });
 it('keeps generic Anthropic discovery on its configured origin and route',async()=>{
  config={...config,provider:'claude',chatApiMode:'anthropic',apiUrl:config.apiUrl.replace('/v1','/anthropic/v1/messages')};
  expect((await discoverServiceModels(config)).models).toHaveLength(1);expect(getRequests[0].url).toBe('/anthropic/v1/models');expect(getRequests[0].headers['x-api-key']).toBe(config.apiKey);
 });
 it.each(['ollama','gemini'] as const)('handles %s model names without duplicating an explicit list endpoint',async(provider)=>{
  config={...config,provider,chatApiMode:'openai',apiUrl:config.apiUrl.replace('/v1',provider==='ollama'?'/api/tags':'/v1beta/models')};
  respondGet=(_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({models:[{name:provider==='ollama'?'gemma:latest':'models/gemini-fixture'}]}));};
  expect((await discoverServiceModels(config)).models[0].id).toBe(provider==='ollama'?'gemma:latest':'models/gemini-fixture');expect(getRequests[0].url).toBe(provider==='ollama'?'/api/tags':'/v1beta/models');
 });
 it.each([{data:[]},{data:[null,{}, {id:0}]},{models:[]},null,'<html>not an API</html>'])('returns an explanatory error for an empty or malformed HTTP 200 result: %j',async(payload)=>{
  respondGet=(_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(payload));};
  const result=await discoverServiceModels(config);expect(result.models).toEqual([]);expect(result.error).toMatch(/空模型列表|没有可用|未返回|不是有效/);expect(result.error).toContain('手动填写');
 });
 it.each([401,404,405,501])('reports HTTP %s instead of pretending discovery succeeded',async(status)=>{
  respondGet=(_request,response)=>{response.statusCode=status;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{message:'fixture failure'}}));};
  const result=await discoverServiceModels(config);expect(result.models).toEqual([]);expect(result.error).toContain(String(status));if(status!==401)expect(result.error).toContain('手动填写');
 });
 it('reports provider errors in HTTP 200 and redacts any echoed credential',async()=>{
  respondGet=(_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{message:`Invalid credential ${config.apiKey}`},data:[]}));};
  const result=await discoverServiceModels(config);expect(result.models).toEqual([]);expect(result.error).toContain('读取模型列表失败');expect(result.error).not.toContain(config.apiKey);expect(result.error).toContain('[已隐藏密钥]');
 });
 it('does not follow redirects or forward credentials to another endpoint',async()=>{
  respondGet=(_request,response)=>{response.statusCode=302;response.setHeader('Location','http://api.xiaomimimo.com/never-request');response.end();};
  const result=await discoverServiceModels(config);expect(result.models).toEqual([]);expect(result.error).toContain('未跟随跳转');expect(getRequests).toHaveLength(1);
 });
 it('rejects sealed keys and invalid credential-bearing URLs before making a request',async()=>{
  expect((await discoverServiceModels({...config,apiKey:'enc:v1:fixture'})).error).toContain('无法解密');expect((await discoverServiceModels({...config,apiUrl:'http://name:secret@127.0.0.1/v1'})).error).toContain('不含用户名或密码');expect((await discoverServiceModels({...config,apiUrl:'not a url'})).error).toContain('有效');expect(getRequests).toEqual([]);
 });
});

describe('MiMo catalog URL resolution',()=>{
 it.each(['https://api.xiaomimimo.com','https://api.xiaomimimo.com/v1','https://api.xiaomimimo.com/anthropic','https://api.xiaomimimo.com/anthropic/v1/messages','https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'])('keeps %s on the same origin and uses the documented catalog path',apiUrl=>{expect(resolveModelDiscoveryUrl({...config,provider:'custom',chatApiMode:'anthropic',apiUrl})).toBe(`${new URL(apiUrl).origin}/v1/models`);});
 it('does not treat an impostor domain as MiMo or redirect a gateway key to the official service',()=>{const apiUrl='https://api.xiaomimimo.com.other.invalid/anthropic/v1/messages';expect(resolveModelDiscoveryUrl({...config,provider:'custom',chatApiMode:'anthropic',apiUrl})).toBe('https://api.xiaomimimo.com.other.invalid/anthropic/v1/models');});
});
