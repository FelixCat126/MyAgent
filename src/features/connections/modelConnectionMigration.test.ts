import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
const mocks=vi.hoisted(()=>({flush:vi.fn<()=>Promise<void>>()}));
vi.mock('../../utils/zustandFileStorage',async()=>{const {createJSONStorage}=await import('zustand/middleware');return {zustandPersistJson:createJSONStorage(()=>localStorage),flushZustandFilePersist:mocks.flush};});
import { useConnectionStore, resolveModelConnectionFrom, type ServiceConnection } from '../../store/connectionStore';
import { useModelStore } from '../../store/modelStore';
import { installModelConnectionMigration, planModelConnectionMigration } from './modelConnectionMigration';
import { PERSIST_KEYS } from '../../utils/persistKeys';

const base:ModelConfig={id:'m',name:'Shared service',provider:'custom',apiUrl:'https://service.example/v1',apiKey:'dummy-chat-key',modelName:'llm-one',chatApiMode:'openai',isLocal:false,maxTokens:2048};
const withoutLink=(model:ModelConfig)=>{const{connectionId:_id,...value}=model;return value;};
function ids(){let id=0;return()=>`service-${++id}`;}
function fixture():ModelConfig[]{return [
  {...base,id:'gemma',name:'Gemma4 12B',provider:'ollama',apiUrl:'http://127.0.0.1:11434',apiKey:'',modelName:'gemma4:12b',isLocal:true},
  {...base,id:'local-image',name:'SD1.5',apiUrl:'',apiKey:'',modelName:'',isLocal:true,isChatModel:false,isImageGenerator:true,imageGeneratorConfig:{type:'cli',command:'/fixture/image',env:{MODEL:'sd1.5'},cliArgLines:'{{prompt}}'}},
  {...base,id:'minimax',name:'MiniMax',apiUrl:'https://api.minimax.cn/anthropic/v1',chatApiMode:'anthropic',isImageGenerator:true,imageGeneratorConfig:{type:'http',endpoint:'https://images.example/minimax',apiKey:'dummy-image-minimax',apiKeySource:'independent',provider:'custom',env:{IMAGE_API_KEY:'dummy-other-auth'}}},
  {...base,id:'glm',name:'GLM',apiUrl:'https://open.bigmodel.cn/api/paas/v4',isImageGenerator:true,imageGeneratorConfig:{type:'http',endpoint:'https://images.example/glm',apiKey:'dummy-image-glm',apiKeySource:'independent',provider:'custom'}},
  {...base,id:'kimi',name:'Kimi',apiUrl:'https://api.kimi.com/v1',modelName:'k3'},
  {...base,id:'mimo',name:'MIMO',apiUrl:'https://api.xiaomimimo.com/anthropic',chatApiMode:'anthropic'},
];}
describe('legacy service organization invariants',()=>{
 it('organizes the real six-model shape into five services without changing effective configuration',()=>{
  const models=fixture().map((model,index)=>({...model,capabilities:{checkedAt:index,signature:`existing-${index}`,chat:'verified' as const}}));
  const plan=planModelConnectionMigration({models,connections:[]},ids(),123);
  expect([plan.addedServices,plan.linkedModels]).toEqual([5,5]);
  plan.models.forEach((model,index)=>expect(withoutLink(resolveModelConnectionFrom(model,plan.connections))).toEqual(withoutLink(models[index])));
  expect(plan.models[1]).toBe(models[1]);expect(plan.models[2].imageGeneratorConfig).toBe(models[2].imageGeneratorConfig);
  const again=planModelConnectionMigration(plan,ids(),456);expect(again.changed).toBe(false);expect(again.connections).toBe(plan.connections);
 });
 it('shares exact service and auth only, separating endpoint/provider/key/local policy and A/O protocol',()=>{
  const models=[base,{...base,id:'twin',modelName:'llm-two'}, {...base,id:'endpoint',apiUrl:'https://service.example/v1/'}, {...base,id:'key',apiKey:'different'}, {...base,id:'provider',provider:'openai' as const}, {...base,id:'a',chatApiMode:'anthropic' as const}, {...base,id:'local',isLocal:true}, {...base,id:'auto-o',chatApiMode:'auto' as const}, {...base,id:'auto-a',chatApiMode:'auto' as const,modelName:'MiniMax-M2.7'}];
  const plan=planModelConnectionMigration({models,connections:[]},ids());expect(plan.connections).toHaveLength(8);expect(plan.models[0].connectionId).toBe(plan.models[1].connectionId);expect(plan.models[7].connectionId).not.toBe(plan.models[8].connectionId);
  plan.models.forEach((model,index)=>expect(withoutLink(resolveModelConnectionFrom(model,plan.connections))).toEqual(withoutLink(models[index])));
 });
 it('reuses services saved before a crash without deleting model fallback or existing unrelated services',()=>{
  const partial=planModelConnectionMigration({models:[base],connections:[]},ids());const other:ServiceConnection={id:'other',name:'unrelated',provider:'openai',apiUrl:'https://other.example',apiKey:'other',chatApiMode:'auto',updatedAt:1};
  const recovered=planModelConnectionMigration({models:[base],connections:[other,...partial.connections]},()=>{throw new Error('must reuse');});expect(recovered.addedServices).toBe(0);expect(recovered.models[0].connectionId).toBe(partial.connections[0].id);expect(recovered.models[0].apiKey).toBe(base.apiKey);expect(recovered.connections[0]).toBe(other);
 });
 it('retains detached fallback and sealed credentials and retries only the original pending model',()=>{
  const sealed={...base,id:'sealed',apiKey:'enc:v1:cannot-decrypt'};const detached={...base,id:'detached',connectionId:'missing'};const initial=planModelConnectionMigration({models:[sealed,detached],connections:[]},ids());expect(initial.linkedModels).toBe(0);expect(initial.pendingConnectionMigrationIds).toEqual(['sealed']);expect(initial.models[1]).toBe(detached);
  const retry=planModelConnectionMigration({...initial,models:[{...sealed,apiKey:'decrypted-dummy'},detached,{...base,id:'new-independent'}]},ids());expect(retry.linkedModels).toBe(1);expect(retry.models[2].connectionId).toBeUndefined();expect(retry.pendingConnectionMigrationIds).toEqual([]);
 });
 it('does not recreate a connection explicitly removed or unlinked before the next startup',()=>{
  const initial=planModelConnectionMigration({models:[base],connections:[]},ids());const detached={...initial.models[0],connectionId:undefined};const restart=planModelConnectionMigration({...initial,models:[detached],connections:[]},ids());expect(restart.changed).toBe(false);expect(restart.connections).toEqual([]);expect(restart.models[0].connectionId).toBeUndefined();
 });
 it('preserves independent video credentials and media-only HTTP/CLI boundaries',()=>{
  const video={...base,id:'video',isVideoGenerator:true,videoGeneratorConfig:{provider:'custom',model:'video-only',endpoint:'https://video.example/submit',apiKey:'independent-video-key',duration:6 as const}};
  const media={...base,id:'image',isChatModel:false,isImageGenerator:true,imageGeneratorConfig:{type:'http' as const,endpoint:'https://service.example/images',apiKey:'independent-image-key'}};
  const plan=planModelConnectionMigration({models:[video,media],connections:[]},ids());expect(plan.linkedModels).toBe(1);expect(resolveModelConnectionFrom(plan.models[0],plan.connections).videoGeneratorConfig).toEqual(video.videoGeneratorConfig);expect(plan.models[1]).toBe(media);
 });
 it('retains a separate video service and does not automatically reuse that service for chat',()=>{
  const mediaService:ServiceConnection={id:'video-service',name:'Video service',provider:base.provider,apiUrl:base.apiUrl,apiKey:base.apiKey!,chatApiMode:base.chatApiMode,updatedAt:1};
  const combined={...base,videoGeneratorConfig:{connectionId:mediaService.id,provider:'custom',model:'video',endpoint:'https://different-video.example/submit',apiKey:'offline-video-fallback'}};
  const before=resolveModelConnectionFrom(combined,[mediaService]);const plan=planModelConnectionMigration({models:[combined],connections:[mediaService]},ids());
  expect(plan.addedServices).toBe(1);expect(plan.models[0].connectionId).not.toBe(mediaService.id);expect(plan.models[0].videoGeneratorConfig?.connectionId).toBe(mediaService.id);expect(withoutLink(resolveModelConnectionFrom(plan.models[0],plan.connections))).toEqual(withoutLink(before));expect(plan.models[0].videoGeneratorConfig?.apiKey).toBe('offline-video-fallback');
 });
});

describe('hydrated migration and durability',()=>{
 const disposers:Array<()=>void>=[];
 const getPersist=vi.fn(async(name:string)=>localStorage.getItem(name));
 beforeEach(()=>{localStorage.clear();mocks.flush.mockReset().mockResolvedValue();getPersist.mockClear();vi.stubGlobal('electron',{persistGet:getPersist});useConnectionStore.setState({connections:[],organizationSummary:{services:0,models:0,organizedServices:0,organizedModels:0,skippedModels:0,status:'pending'}});useModelStore.setState({models:fixture(),activeModelId:'kimi',imageGenModelId:'minimax',connectionMigrationVersion:0,pendingConnectionMigrationIds:[]});});
 afterEach(()=>{disposers.splice(0).forEach(dispose=>dispose());});
 it('is StrictMode-safe, persists services before links, and preserves selected chat/image models',async()=>{
  const snapshots:Array<[number,number]>=[];mocks.flush.mockImplementation(async()=>{snapshots.push([useConnectionStore.getState().connections.length,useModelStore.getState().models.filter(m=>m.connectionId).length]);});
  const first=installModelConnectionMigration();first();disposers.push(installModelConnectionMigration(),installModelConnectionMigration());
  await vi.waitFor(()=>expect(useConnectionStore.getState().organizationSummary.status).toBe('ready'));
  expect(snapshots[0]).toEqual([5,0]);expect(useModelStore.getState().activeModelId).toBe('kimi');expect(useModelStore.getState().imageGenModelId).toBe('minimax');expect(useModelStore.getState().connectionMigrationVersion).toBe(1);expect(useConnectionStore.getState().organizationSummary.organizedModels).toBe(5);expect(useConnectionStore.getState().connections).toHaveLength(5);
 });
 it('does not bind models when the service write fails or a sync write silently loses data',async()=>{
  getPersist.mockResolvedValueOnce(null);disposers.push(installModelConnectionMigration());
  await vi.waitFor(()=>expect(useConnectionStore.getState().organizationSummary.status).toBe('failed'));expect(useModelStore.getState().models.every(model=>!model.connectionId)).toBe(true);expect(useModelStore.getState().connectionMigrationVersion).toBe(0);
 });
 it('rolls back migration state when model persistence fails after services were saved',async()=>{
  mocks.flush.mockResolvedValueOnce().mockRejectedValueOnce(new Error('model save failed'));disposers.push(installModelConnectionMigration());
  await vi.waitFor(()=>expect(useConnectionStore.getState().organizationSummary.status).toBe('failed'));expect(useModelStore.getState().connectionMigrationVersion).toBe(0);expect(useModelStore.getState().models.every(model=>!model.connectionId)).toBe(true);
 });
 it('does not overwrite an independent model edit made while the service write is pending',async()=>{
  let finish!:()=>void;let started=false;mocks.flush.mockImplementationOnce(()=>new Promise<void>(resolve=>{started=true;finish=resolve;}));disposers.push(installModelConnectionMigration());
  await vi.waitFor(()=>expect(started).toBe(true));useModelStore.getState().updateModel('kimi',{apiUrl:'https://edited.example/v1',apiKey:'edited-dummy'});finish();
  await vi.waitFor(()=>expect(useModelStore.getState().connectionMigrationVersion).toBe(1));const edited=useModelStore.getState().models.find(model=>model.id==='kimi')!;expect(resolveModelConnectionFrom(edited,useConnectionStore.getState().connections).apiUrl).toBe('https://edited.example/v1');expect(edited.apiKey).toBe('edited-dummy');
 });
 it('reorganizes restored old repositories and never responds to ordinary unlink/edit actions',async()=>{
  disposers.push(installModelConnectionMigration());await vi.waitFor(()=>expect(useModelStore.getState().connectionMigrationVersion).toBe(1));
  useModelStore.getState().updateModel('kimi',{connectionId:undefined});const linked=useModelStore.getState().models.filter(model=>model.connectionId).length;await new Promise(resolve=>setTimeout(resolve,15));expect(useModelStore.getState().models.filter(model=>model.connectionId).length).toBe(linked);
  await useConnectionStore.persist.rehydrate();await useModelStore.persist.rehydrate();await new Promise(resolve=>setTimeout(resolve,15));expect(useModelStore.getState().models.find(model=>model.id==='kimi')?.connectionId).toBeUndefined();
  localStorage.setItem(PERSIST_KEYS.connection,JSON.stringify({state:{connections:[]},version:1}));localStorage.setItem(PERSIST_KEYS.model,JSON.stringify({state:{models:[{...base,id:'restored'}],activeModelId:'restored',imageGenModelId:null,routingRules:[]},version:3}));
  await Promise.all([useConnectionStore.persist.rehydrate(),useModelStore.persist.rehydrate()]);await vi.waitFor(()=>expect(useModelStore.getState().models[0].connectionId).toBeTruthy());expect(useModelStore.getState().activeModelId).toBe('restored');expect(useConnectionStore.getState().connections).toHaveLength(1);
 });
 it('removes deferred migration when the user explicitly edits an unreadable independent model',()=>{
  useModelStore.setState({pendingConnectionMigrationIds:['kimi']});useModelStore.getState().updateModel('kimi',{capabilities:{checkedAt:1,signature:'x',chat:'verified'}});expect(useModelStore.getState().pendingConnectionMigrationIds).toEqual(['kimi']);useModelStore.getState().updateModel('kimi',{connectionId:undefined});expect(useModelStore.getState().pendingConnectionMigrationIds).toEqual([]);
 });
});
