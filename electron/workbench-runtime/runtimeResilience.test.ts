// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {TaskLedger,nextIntervalRun} from './taskStore';
import {RuntimeScheduler} from './scheduler';
import {trustReadOnlyHint} from './mcpManager';

describe('recurring schedules across sleep and restart',()=>{
  it('aligns the next run to the original cadence instead of drifting',()=>{
    expect(nextIntervalRun(1000,1,1000+5_000)).toBe(1000+60_000);
    expect(nextIntervalRun(1000,1,1000+125_000)).toBe(1000+180_000);
  });
  it('keeps an interval schedule enabled after a missed wake and skips to the next slot',async()=>{
    const dir=await fs.mkdtemp(path.join(tmpdir(),'myagent-interval-'));
    try{
      const ledger=new TaskLedger(path.join(dir,'state.json'));await ledger.load();const now=Date.now();
      await ledger.schedule({title:'monitor',kind:'reminder',prompt:'ping',enabled:true,intervalMinutes:30,nextRunAt:now-45*60_000});
      const scheduler=new RuntimeScheduler(ledger,vi.fn(),vi.fn(),()=>{});
      await scheduler.tick(now);
      const schedule=ledger.state.schedules[0];
      expect(schedule.enabled).toBe(true);
      expect(schedule.missedAt).toBeUndefined();
      expect(schedule.nextRunAt).toBeGreaterThan(now);
      expect(schedule.nextRunAt).toBe(now-45*60_000+60*60_000);
      expect(ledger.state.tasks).toHaveLength(0);
      await scheduler.stop();
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
  it('advances interval schedules missed while the app was closed',async()=>{
    const dir=await fs.mkdtemp(path.join(tmpdir(),'myagent-interval-'));
    try{
      const ledger=new TaskLedger(path.join(dir,'state.json'));await ledger.load();
      await ledger.schedule({title:'monitor',kind:'reminder',enabled:true,intervalMinutes:10,nextRunAt:Date.now()-25*60_000});
      const restored=new TaskLedger(ledger.file);await restored.load();
      expect(restored.state.schedules[0].enabled).toBe(true);
      expect(restored.state.schedules[0].nextRunAt).toBeGreaterThan(Date.now());
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
});

describe('MCP read-only hint',()=>{
  it('trusts readOnlyHint only for names without write verbs',()=>{
    expect(trustReadOnlyHint('search_issues',true)).toBe(true);
    expect(trustReadOnlyHint('getFile',true)).toBe(true);
    expect(trustReadOnlyHint('delete_issue',true)).toBe(false);
    expect(trustReadOnlyHint('sendMessage',true)).toBe(false);
    expect(trustReadOnlyHint('search_issues',undefined)).toBe(false);
  });
});
