import type { ModelConfig } from '../../types';
import { useModelStore } from '../../store/modelStore';
import { resolveModelConnectionFrom, useConnectionStore, validateConnection, type ConnectionOrganizationSummary, type ServiceConnection } from '../../store/connectionStore';
import { resolveChatApiMode } from '../../utils/chatApiMode';
import { flushZustandFilePersist } from '../../utils/zustandFileStorage';
import { newId } from '../../utils/newId';
import { PERSIST_KEYS } from '../../utils/persistKeys';

const MIGRATION_VERSION = 1;
type MigrationInput = {
  models: ModelConfig[]; connections: ServiceConnection[];
  connectionMigrationVersion?: number; pendingConnectionMigrationIds?: string[];
};
export type ModelConnectionMigrationPlan = {
  models: ModelConfig[]; connections: ServiceConnection[];
  connectionMigrationVersion: number; pendingConnectionMigrationIds: string[];
  changed: boolean; addedServices: number; linkedModels: number;
};
function unreadableSecret(value: unknown, secret = false): boolean {
  if(typeof value==='string')return secret&&(/^(enc:v1:|runtime:secret:v1:)/.test(value.trim())||/^•+$/.test(value));
  if(Array.isArray(value))return value.some(item=>unreadableSecret(item,secret));
  if(!value||typeof value!=='object')return false;
  return Object.entries(value).some(([key,item])=>unreadableSecret(item,secret||key==='apiKey'||key==='token'||key==='env'));
}
function configurationWithoutLink(model:ModelConfig):string{
  const {connectionId:_link,...config}=model;return JSON.stringify(config);
}
function matches(model:ModelConfig, connection:ServiceConnection, connections:readonly ServiceConnection[]):boolean{
  if(unreadableSecret(connection)||model.provider!==connection.provider||model.apiUrl!==connection.apiUrl||(model.apiKey??'')!==connection.apiKey||model.chatApiMode!==connection.chatApiMode)return false;
  const serviceMode=connection.effectiveChatApiMode??resolveChatApiMode({...connection,modelName:''});
  if(resolveChatApiMode(model)!==serviceMode)return false;
  const effective=resolveModelConnectionFrom({...model,connectionId:connection.id},[...connections,connection]);
  const before=resolveModelConnectionFrom(model,connections);
  return resolveChatApiMode(before)===resolveChatApiMode(effective)&&configurationWithoutLink(before)===configurationWithoutLink(effective);
}

/** Only consolidate proven identical chat settings; retain every original fallback/media field. */
export function planModelConnectionMigration(input:MigrationInput, createId:()=>string=newId, now=Date.now()):ModelConnectionMigrationPlan{
  const first=(input.connectionMigrationVersion??0)<MIGRATION_VERSION;
  const retry=new Set(input.pendingConnectionMigrationIds||[]);
  const mediaConnections=new Set(input.models.flatMap(model=>[model?.videoGeneratorConfig?.connectionId,...(model?.isChatModel===false&&model?.connectionId?[model.connectionId]:[])].filter((id):id is string=>Boolean(id))));
  const pending:string[]=[];const connections=[...input.connections];let linkedModels=0;
  const models=input.models.map(model=>{
    if(!model||typeof model.name!=='string'||typeof model.apiUrl!=='string'||typeof model.modelName!=='string'||typeof model.isLocal!=='boolean'||(model.apiKey!==undefined&&typeof model.apiKey!=='string'))return model;
    if(!first&&!retry.has(model.id))return model;
    if(model.connectionId||model.isChatModel===false||(!model.modelName?.trim())||validateConnection({name:model.name,apiUrl:model.apiUrl}))return model;
    if(unreadableSecret(model)){pending.push(model.id);return model;}
    let service=connections.find(connection=>!mediaConnections.has(connection.id)&&matches(model,connection,connections));
    if(!service){
      let id=createId();let attempts=0;while(connections.some(connection=>connection.id===id)&&attempts++<100)id=createId();
      if(connections.some(connection=>connection.id===id))return model;
      service={id,name:model.provider==='ollama'?'Ollama':model.name,provider:model.provider,apiUrl:model.apiUrl,apiKey:model.apiKey??'',chatApiMode:model.chatApiMode,effectiveChatApiMode:resolveChatApiMode(model),isLocal:model.isLocal,autoOrganized:true,updatedAt:now};
      if(!matches(model,service,connections))return model;
      connections.push(service);
    }
    linkedModels++;return {...model,connectionId:service.id};
  });
  const changed=first||linkedModels>0||JSON.stringify(input.pendingConnectionMigrationIds||[])!==JSON.stringify(pending);
  return {models:linkedModels?models:input.models,connections:connections.length===input.connections.length?input.connections:connections,connectionMigrationVersion:MIGRATION_VERSION,pendingConnectionMigrationIds:pending,changed,addedServices:connections.length-input.connections.length,linkedModels};
}

function summary(status:ConnectionOrganizationSummary['status']='ready'):ConnectionOrganizationSummary{
  const models=useModelStore.getState();const {connections}=useConnectionStore.getState();const linked=models.models.filter(model=>model.connectionId&&connections.some(connection=>connection.id===model.connectionId));
  return {services:connections.length,models:linked.length,organizedServices:connections.filter(connection=>connection.autoOrganized).length,organizedModels:linked.filter(model=>connections.some(connection=>connection.id===model.connectionId&&connection.autoOrganized)).length,skippedModels:models.pendingConnectionMigrationIds.length,status};
}
function publish(status:ConnectionOrganizationSummary['status']='ready'):void{
  const next=summary(status);if(JSON.stringify(useConnectionStore.getState().organizationSummary)!==JSON.stringify(next))useConnectionStore.setState({organizationSummary:next});
}
async function readWrittenRepository(name:string):Promise<Record<string,unknown>|null>{
  const api=typeof window!=='undefined'?window.electron:undefined;
  const text=api?.persistGet?await api.persistGet(name):localStorage.getItem(name);
  return text?JSON.parse(text).state:null;
}
let mounts=0;let uninstall:(()=>void)|undefined;let migrating=false;let rerun=false;
let modelReady=false;let connectionReady=false;let hydrationEpoch=0;let timer:ReturnType<typeof setTimeout>|undefined;
function schedule():void{
  if(!mounts||!modelReady||!connectionReady)return;
  if(migrating){rerun=true;return;}
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{timer=undefined;void organize();},0);
}
async function organize():Promise<void>{
  if(migrating||!mounts||!modelReady||!connectionReady)return;
  migrating=true;const epoch=hydrationEpoch;const source=useModelStore.getState();const previous=useConnectionStore.getState().connections;
  const plan=planModelConnectionMigration({...source,connections:previous});
  try{
    if(!plan.changed){publish();return;}
    if(plan.connections!==previous)useConnectionStore.setState({connections:plan.connections});
    if(plan.linkedModels){
      await flushZustandFilePersist();
      const written=await readWrittenRepository(PERSIST_KEYS.connection);
      if(JSON.stringify(written?.connections)!==JSON.stringify(plan.connections))throw new Error('Service settings were not saved');
    }
    // A restore, user edit, or unmount during the write must not bind stale model state.
    if(!mounts||epoch!==hydrationEpoch||!modelReady||!connectionReady||useModelStore.getState().models!==source.models||useConnectionStore.getState().connections!==plan.connections){rerun=true;return;}
    useModelStore.setState({models:plan.models,connectionMigrationVersion:plan.connectionMigrationVersion,pendingConnectionMigrationIds:plan.pendingConnectionMigrationIds});
    await flushZustandFilePersist();
    const written=await readWrittenRepository(PERSIST_KEYS.model);
    if(written?.connectionMigrationVersion!==plan.connectionMigrationVersion||JSON.stringify(written.models)!==JSON.stringify(plan.models)||JSON.stringify(written.pendingConnectionMigrationIds)!==JSON.stringify(plan.pendingConnectionMigrationIds))throw new Error('Model organization was not saved');
    publish();
  }catch{
    const current=useModelStore.getState();
    if(current.models===plan.models&&current.connectionMigrationVersion===plan.connectionMigrationVersion)useModelStore.setState({models:source.models,connectionMigrationVersion:source.connectionMigrationVersion,pendingConnectionMigrationIds:source.pendingConnectionMigrationIds});
    // Successfully saved services can be reused after a crash; never link models when saving fails.
    if(useConnectionStore.getState().connections===plan.connections&&plan.connections!==previous)useConnectionStore.setState({connections:previous});
    publish('failed');
  }finally{migrating=false;if(rerun){rerun=false;schedule();}}
}

/** Mount once in App; StrictMode and subsequent backup rehydration share this guarded installer. */
export function installModelConnectionMigration():()=>void{
  mounts++;
  if(mounts===1){
    modelReady=useModelStore.persist.hasHydrated();connectionReady=useConnectionStore.persist.hasHydrated();
    const disposers=[
      useModelStore.persist.onHydrate(()=>{modelReady=false;hydrationEpoch++;}),
      useConnectionStore.persist.onHydrate(()=>{connectionReady=false;hydrationEpoch++;}),
      useModelStore.persist.onFinishHydration(()=>{modelReady=true;schedule();}),
      useConnectionStore.persist.onFinishHydration(()=>{connectionReady=true;schedule();}),
    ];
    uninstall=()=>{for(const dispose of disposers)dispose();if(timer)clearTimeout(timer);timer=undefined;};
    schedule();
  }
  let disposed=false;return()=>{if(disposed)return;disposed=true;if(--mounts===0){uninstall?.();uninstall=undefined;}};
}
