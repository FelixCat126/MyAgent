import { randomInt } from 'node:crypto';
import { callModelRequest } from './model';
import { ipcMain } from 'electron';
import axios from 'axios';
import { MODEL_STREAM_TIMEOUT_MS } from '../constants/timeouts';
import { createCanvas } from '@napi-rs/canvas';
import type { Message,ModelConfig } from '../../src/types';
import type { NativeToolDefinition,ModelRoundResult,DiagnosticCheck,ModelDiagnosticReport } from '../../src/features/connections/api';
import { resolveChatApiMode,resolveAnthropicMessagesUrl,buildAnthropicAuthHeaders,buildAnthropicThinkingParams } from '../../src/utils/chatApiMode';
import { resolveOpenAiCompatibleBaseUrl } from '../../src/utils/openAiCompatBase';
import { consumeSseLines } from '../utils/sseStreamCompletion';
import { anthropicAgentMessages,openAiAgentMessages,nativeToolPayload,NativeModelAccumulator } from '../utils/nativeModelProtocol';
import { isZhipuEndpoint, buildThinkingParams } from './openai-adapters';
import { mapModelCallError } from '../../src/utils/modelErrors';

const controllers=new Map<string,AbortController>();
type RoundOptions={config:ModelConfig;messages:Message[];tools:NativeToolDefinition[];stream?:boolean;signal?:AbortSignal;onThinking?:(text:string)=>void;probe?:boolean};
export async function requestNativeModelRound(options:RoundOptions):Promise<ModelRoundResult>{
  const {config,messages,tools,signal}=options;
  if (!config?.modelName?.trim() || !/^https?:\/\//i.test(config.apiUrl)) throw new Error('模型与接口地址不能为空');
  if (config.apiKey?.startsWith('enc:v1:')) throw new Error('当前系统无法解密 API 密钥，请重新输入');
  if (config.provider==='gemini' && resolveChatApiMode(config)!=='anthropic') throw new Error('NATIVE_TOOLS_UNSUPPORTED');
  const anthropic=resolveChatApiMode(config)==='anthropic';
  const headers=anthropic?buildAnthropicAuthHeaders(config):{'Content-Type':'application/json',...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})};
  const conversation=anthropic?anthropicAgentMessages(messages):{messages:openAiAgentMessages(messages,isZhipuEndpoint(config.apiUrl,config.modelName)||/minimax|mimo/i.test(config.apiUrl)),system:''};
  const body:Record<string,unknown>={model:config.modelName,messages:conversation.messages,max_tokens:options.probe?512:Math.max(1,config.maxTokens||4096),stream:options.stream!==false,
    ...(conversation.system?{system:conversation.system}:{}),...(tools.length?{tools:nativeToolPayload(tools,anthropic)}:{})};
  const thinking=options.probe?{}:anthropic?buildAnthropicThinkingParams({apiUrl:config.apiUrl,modelName:config.modelName,provider:config.provider,maxTokens:config.maxTokens}):buildThinkingParams({apiUrl:config.apiUrl,modelName:config.modelName,stream:options.stream!==false});
  const post=(extra:Record<string,unknown>)=>axios.post(anthropic?resolveAnthropicMessagesUrl(config.apiUrl):`${resolveOpenAiCompatibleBaseUrl(config.apiUrl,config.provider)}/chat/completions`,{...body,...extra},
    {headers,responseType:options.stream===false?'json':'stream',timeout:options.probe?30_000:120_000,signal,validateStatus:s=>s>=200&&s<300});
  let response;
  try{response=await post(thinking);}catch(error){
    const status=(error as {response?:{status?:number}}).response?.status;
    const detail=JSON.stringify((error as {response?:{data?:unknown}}).response?.data||'');
    if(Object.keys(thinking).length && (status===400||status===422) && /thinking|reasoning|unsupported.*param|unknown.*param/i.test(detail))response=await post({});else throw error;
  }
  const accumulator=new NativeModelAccumulator(options.onThinking);
  if(options.stream===false){
    if(anthropic){
      for(const [index,block] of (response.data.content||[]).entries()){
        accumulator.feed({type:'content_block_start',index,content_block:block});
        if(block.type==='thinking')accumulator.addThinking(block.thinking||'');
      }
    } else accumulator.feed(response.data);
  }else await consumeSseLines(response.data,line=>{
    if(!line.startsWith('data:'))return;
    const raw=line.slice(5).trim(); if(!raw||raw==='[DONE]')return;
    let data:Record<string,unknown>; try{data=JSON.parse(raw);}catch{return;}
    accumulator.feed(data);
  },{firstEventTimeoutMs:options.probe?30_000:90_000,maxDurationMs:options.probe?45_000:MODEL_STREAM_TIMEOUT_MS});
  return accumulator.finish();
}
const probeTool:NativeToolDefinition={name:'connection_probe',description:'Return the requested code to verify tool calling. No external side effects.',parameters:{type:'object',properties:{code:{type:'string',enum:['MYAGENT_OK']}},required:['code'],additionalProperties:false}};
export async function diagnoseModel(config:ModelConfig,kinds:DiagnosticCheck['kind'][]=['chat','history','stream','tools']):Promise<ModelDiagnosticReport>{
  const checks:DiagnosticCheck[]=[];
  if(!Array.isArray(kinds)||kinds.length>5||kinds.some(kind=>!['chat','history','stream','tools','vision'].includes(kind)))throw new Error('无效诊断项');
  for(const kind of [...new Set(kinds)]){
    if(config.provider==='gemini' && (kind==='stream'||kind==='tools')){checks.push({kind,status:'unverified',detail:'当前 Gemini 适配器未实现这项能力'});continue;}
    const started=Date.now(); const base={id:'probe',role:'user' as const,content:'Reply with OK.',timestamp:started,model:config.name};
    let messages:Message[]=[base]; let expectedVision:string|undefined;
    if(kind==='history')messages=[{...base,content:'Remember the code MYAGENT_HISTORY.'},{...base,id:'a',role:'assistant',content:'The code is MYAGENT_HISTORY.'},{...base,id:'b',content:'Return the exact code I asked you to remember.'}];
    if(kind==='tools')messages=[{...base,content:'Call connection_probe with code MYAGENT_OK. Do not answer in text.'}];
    if(kind==='vision'){
      const palette=[['red','#ff0000'],['blue','#0000ff'],['green','#008000'],['yellow','#ffff00'],['purple','#800080'],['orange','#ffa500']];
      const left=randomInt(palette.length),right=(left+1+randomInt(palette.length-1))%palette.length; expectedVision=`left=${palette[left][0]},right=${palette[right][0]}`;
      const canvas=createCanvas(64,32);const ctx=canvas.getContext('2d');ctx.fillStyle=palette[left][1];ctx.fillRect(0,0,32,32);ctx.fillStyle=palette[right][1];ctx.fillRect(32,0,32,32);
      const bytes=canvas.toBuffer('image/png');messages=[{...base,content:'Identify the colors shown in the LEFT and RIGHT halves of the attached image. Reply only in the format left=COLOR,right=COLOR using English color names. Do not guess without seeing the image.',files:[{name:'probe.png',path:'',type:'image/png',size:bytes.length,preview:`data:image/png;base64,${bytes.toString('base64')}`}]}];
    }
    try{
      const response:ModelRoundResult=config.provider==='gemini'?{...await callModelRequest(messages,config,{connectionTest:true}),nativeTools:false}:await requestNativeModelRound({config,messages,tools:kind==='tools'?[probeTool]:[],stream:kind==='stream',probe:true});
      const valid=kind==='history'?response.content.includes('MYAGENT_HISTORY'):kind==='tools'?response.toolCalls?.some(t=>t.name==='connection_probe'&&t.arguments.code==='MYAGENT_OK'):
        kind==='vision'?response.content.toLowerCase().replace(/\s+/g,'').includes(expectedVision||'__invalid__'):Boolean(response.content.trim());
      checks.push({kind,status:valid?'verified':'failed',elapsedMs:Date.now()-started,detail:valid?undefined:'接口有响应，但没有完成本项测试 / Response did not satisfy the check'});
    }catch(e){checks.push({kind,status:'failed',elapsedMs:Date.now()-started,detail:mapModelCallError(e,'zh')});}
  }
  return {checkedAt:Date.now(),checks};
}
type DiscoveryConfig = Pick<ModelConfig, 'provider' | 'apiUrl' | 'apiKey' | 'chatApiMode'>;
type DiscoveryResult = { models: Array<{ id: string }>; error?: string };
const manualModelHint = '可按服务商文档在“对话与图片”中手动填写模型标识；发现列表失败不代表对话接口不可用。';

function isOfficialMiMoHost(hostname: string): boolean {
  return hostname === 'api.xiaomimimo.com' || /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/.test(hostname);
}

/** Model catalogs do not necessarily share a provider's Anthropic chat route. */
export function resolveModelDiscoveryUrl(config: DiscoveryConfig): string {
  let input: URL;
  try { input = new URL(String(config?.apiUrl ?? '').trim()); }
  catch { throw new Error('请输入有效的 HTTP 或 HTTPS 服务地址。'); }
  if (!['http:', 'https:'].includes(input.protocol) || input.username || input.password) throw new Error('请输入不含用户名或密码的 HTTP 或 HTTPS 服务地址。');
  const path = input.pathname.replace(/\/+$/, '');
  input.hash = '';
  // MiMo documents GET /v1/models for both O and A chat configurations. Keep the same origin.
  if (isOfficialMiMoHost(input.hostname)) input.pathname = '/v1/models';
  else if (config.provider === 'ollama') input.pathname = /\/api\/tags$/i.test(path) ? path : `${path.replace(/\/v1$/i, '')}/api/tags`;
  else if (/\/models$/i.test(path)) input.pathname = path;
  else if (config.provider === 'gemini') input.pathname = `${path}/models`;
  else if (resolveChatApiMode(config) === 'anthropic') {
    const messagesUrl = new URL(resolveAnthropicMessagesUrl(`${input.origin}${path}`));
    input.pathname = messagesUrl.pathname.replace(/\/messages$/i, '/models');
  } else {
    const base = new URL(resolveOpenAiCompatibleBaseUrl(`${input.origin}${path}`, config.provider));
    input.pathname = `${base.pathname.replace(/\/+$/, '')}/models`;
  }
  return input.toString();
}

function redactDiscoveryError(text: string, key?: string): string {
  let clean = text;
  for (const secret of new Set([key, key?.trim(), key ? encodeURIComponent(key) : undefined])) {
    if (secret) clean = clean.split(secret).join('[已隐藏密钥]');
  }
  return clean.slice(0, 1500);
}

export async function discoverServiceModels(config: DiscoveryConfig): Promise<DiscoveryResult> {
  try {
    if (config?.apiKey?.startsWith('enc:v1:')) throw new Error('当前系统无法解密 API 密钥，请在该服务连接中重新输入密钥。');
    const url = resolveModelDiscoveryUrl(config);
    const anthropic = resolveChatApiMode(config) === 'anthropic';
    const headers = isOfficialMiMoHost(new URL(url).hostname)
      ? config.apiKey ? { 'api-key': config.apiKey } : {}
      : anthropic ? buildAnthropicAuthHeaders(config)
      : config.provider === 'gemini' ? { 'x-goog-api-key': config.apiKey || '' }
      : config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const response = await axios.get(url, { headers, timeout: 10_000, maxContentLength: 4 * 1024 * 1024, maxRedirects: 0 });
    const payload: unknown = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`服务响应不是有效的模型列表。${manualModelHint}`);
    const data = payload as Record<string, unknown>;
    if (data.error) {
      const message = typeof data.error === 'string' ? data.error : typeof data.error === 'object' && typeof (data.error as { message?: unknown }).message === 'string' ? (data.error as { message: string }).message : '服务返回了错误响应';
      throw new Error(`读取模型列表失败：${redactDiscoveryError(message, config.apiKey)}。${manualModelHint}`);
    }
    const named = config.provider === 'ollama' || config.provider === 'gemini';
    const entries = named ? data.models : data.data;
    if (!Array.isArray(entries)) throw new Error(`服务未返回预期的模型列表字段（${named ? 'models' : 'data'}）。${manualModelHint}`);
    const ids = entries.slice(0, 1000).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const entry = item as { id?: unknown; name?: unknown };
      const raw = named ? entry.name ?? entry.id : entry.id ?? entry.name;
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000 || /[\u0000-\u001f\u007f]/.test(raw)) return [];
      return [raw.trim()];
    });
    const models = [...new Set(ids)].map(id => ({ id }));
    if (!models.length) throw new Error(entries.length ? `列表中没有可用的模型标识。${manualModelHint}` : `服务返回了空模型列表，当前密钥可能没有可列出的模型。${manualModelHint}`);
    return { models };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    const detail = status === 404 || status === 405 || status === 501
      ? `当前端点未提供模型列表接口（HTTP ${status}）。请核对服务地址。${manualModelHint}`
      : status && status >= 300 && status < 400
      ? '模型列表接口发生重定向，请配置最终服务地址后重试；为保护密钥，本次未跟随跳转。'
      : mapModelCallError(error, 'zh');
    return { models: [], error: redactDiscoveryError(detail, config?.apiKey) };
  }
}
ipcMain.handle('model-service:discover', (_event, config: DiscoveryConfig) => discoverServiceModels(config));
ipcMain.handle('model-service:diagnose',(_e,config:ModelConfig,checks?:DiagnosticCheck['kind'][])=>diagnoseModel(config,checks));
ipcMain.handle('model-service:agent',async(event,arg:RoundOptions&{requestId:string})=>{
  if(typeof arg.requestId!=='string'||arg.requestId.length>160||arg.tools.length>128)throw new Error('无效工具请求');
  const key=`${event.sender.id}:${arg.requestId}`; controllers.get(key)?.abort(); const controller=new AbortController();controllers.set(key,controller);
  try{return await requestNativeModelRound({...arg,signal:controller.signal,onThinking:text=>{if(!event.sender.isDestroyed())event.sender.send('model-agent-thinking',{requestId:arg.requestId,text});}});}
  catch(e){const status=(e as {response?:{status?:number}}).response?.status;
    const detail=JSON.stringify((e as {response?:{data?:unknown}}).response?.data||'');
    if(arg.tools.length && ((status===400||status===422)&&/tool|function|unsupported|not.?support/i.test(detail) || status===404))throw new Error('NATIVE_TOOLS_UNSUPPORTED');
    throw new Error(mapModelCallError(e,'zh'));
  }finally{if(controllers.get(key)===controller)controllers.delete(key);}
});
ipcMain.on('model-service:abort',(event,id:string)=>controllers.get(`${event.sender.id}:${id}`)?.abort());
