import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import axios from 'axios';
import type { RuntimeSchedule, RuntimeTask } from '../../src/features/runtime/api';
import { TaskLedger } from './taskStore';
export async function directoryFingerprint(directory:string, limit=5000, signal?:AbortSignal):Promise<string> {
  const rows:string[]=[];
  const walk=async(dir:string):Promise<void>=>{if(signal?.aborted)throw new Error('监控已取消');for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.isSymbolicLink())continue;if(signal?.aborted)throw new Error('监控已取消');const full=path.join(dir,entry.name);const stat=await fs.stat(full);rows.push(`${path.relative(directory,full)}:${stat.size}:${stat.mtimeMs}`);if(rows.length>limit)throw new Error('目录超过 5000 个条目，请选择更小范围');if(entry.isDirectory())await walk(full);}};
  await walk(directory); return createHash('sha256').update(rows.join('\n')).digest('hex');
}
export class RuntimeScheduler {
  private timer?:ReturnType<typeof setInterval>;
  private checking=false;
  private cancelled=false;
  private controllers=new Map<string,AbortController>();
  cancelTask(id:string):void{this.controllers.get(id)?.abort();}
  constructor(private ledger:TaskLedger,private dispatch:(task:RuntimeTask)=>void,private notify:(title:string,body:string)=>void,private changed:()=>void){}
  start():void {this.cancelled=false;this.timer=setInterval(()=>void this.tick(),15_000);this.timer.unref();}
  async stop():Promise<void>{this.cancelled=true;if(this.timer)clearInterval(this.timer);for(const controller of this.controllers.values())controller.abort();}
  async tick(now=Date.now()):Promise<void>{
    if(this.checking||this.cancelled)return;this.checking=true;
    try {for(const schedule of this.ledger.state.schedules){if(this.cancelled)break;if(!schedule.enabled||schedule.nextRunAt>now)continue;
      if(now-schedule.nextRunAt>60_000){schedule.missedAt=schedule.nextRunAt;schedule.enabled=false;schedule.lastError='应用休眠或长时间未检查时错过计划，请手动执行或重新启用';await this.ledger.save();this.notify('计划已错过',schedule.title);this.changed();continue;}
      // Claim and persist the occurrence before execution; closing the app cannot replay it silently.
      const due=schedule.nextRunAt;schedule.nextRunAt=schedule.intervalMinutes?now+schedule.intervalMinutes*60_000:now;schedule.enabled=Boolean(schedule.intervalMinutes);await this.ledger.save();
      try {await this.run(schedule,`schedule:${schedule.id}:${due}`);}catch(error){schedule.lastError=error instanceof Error?error.message:String(error);this.notify('计划执行失败',`${schedule.title}：${schedule.lastError}`);await this.ledger.save();}
      this.changed();
    }}finally{this.checking=false;}
  }
  async runNow(id:string):Promise<RuntimeTask>{const schedule=this.ledger.state.schedules.find(s=>s.id===id);if(!schedule)throw new Error('计划不存在');return this.run(schedule,`manual:${id}:${Date.now()}`);}
  private async run(schedule:RuntimeSchedule,idempotencyKey:string):Promise<RuntimeTask>{
    const task=await this.ledger.create({title:schedule.title,kind:schedule.kind,prompt:schedule.prompt,idempotencyKey,checkpoint:{scheduleId:schedule.id}});
    if(task.status!=='queued')return task;
    await this.ledger.start(task.id);
    return this.execute(task,schedule);
  }
  async retryTask(id:string):Promise<RuntimeTask>{const task=this.ledger.task(id);const schedule=this.ledger.state.schedules.find(s=>s.id===task.checkpoint?.scheduleId);if(!schedule)throw new Error('原监控计划已不存在，请重新创建计划');await this.ledger.start(id,true);return this.execute(task,schedule);}
  private async execute(task:RuntimeTask,schedule:RuntimeSchedule):Promise<RuntimeTask>{
    if(schedule.kind==='agent'){this.dispatch(task);this.notify('计划任务开始',schedule.title);this.changed();return task;}
    try {
      if(schedule.kind==='reminder'){await this.ledger.finish(task.id,{message:schedule.prompt||schedule.title});this.notify(schedule.title,schedule.prompt||'计划提醒时间已到');}
      else {
        await this.ledger.step({taskId:task.id,key:'monitor-check',title:'检查变化',status:'running'});
        let fingerprint:string;
        if(schedule.kind==='web-monitor'){
          const controller=new AbortController();this.controllers.set(task.id,controller);
          try {const response=await axios.get<string>(schedule.url!,{timeout:15_000,signal:controller.signal,responseType:'text',maxContentLength:2*1024*1024,maxBodyLength:2*1024*1024,maxRedirects:3,headers:{'User-Agent':'MyAgent-Monitor/1.2'}});fingerprint=createHash('sha256').update(String(response.data)).digest('hex');}
          finally {this.controllers.delete(task.id);}
        }else {if(!this.ledger.state.allowedDirectories.includes(schedule.directory!))throw new Error('目录授权已失效，请重新选择');const controller=new AbortController();this.controllers.set(task.id,controller);try{fingerprint=await directoryFingerprint(schedule.directory!,5000,controller.signal);}finally{this.controllers.delete(task.id);}}
        if(task.status==='cancelled')return task;
        const changed=Boolean(schedule.fingerprint&&schedule.fingerprint!==fingerprint);schedule.fingerprint=fingerprint;schedule.lastCheckedAt=Date.now();schedule.lastError=undefined;
        await this.ledger.step({taskId:task.id,key:'monitor-check',title:'检查变化',status:'completed',result:{changed,checkedAt:schedule.lastCheckedAt}});
        await this.ledger.finish(task.id,{changed,baseline:!changed});
        if(changed)this.notify('发现变化',schedule.title);
        await this.ledger.save();
      }
    }catch(error){if(task.status==='cancelled')return task;await this.ledger.step({taskId:task.id,key:'monitor-check',title:'检查变化',status:'failed',error:error instanceof Error?error.message:String(error)});await this.ledger.finish(task.id,undefined,error instanceof Error?error.message:String(error));throw error;}
    this.changed();return task;
  }
}
