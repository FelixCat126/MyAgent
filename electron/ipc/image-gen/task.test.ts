// @vitest-environment node
import { expect, it } from 'vitest';
import { imageTaskContext, bindImageTask, checkImageTask } from './task';
import { enqueueSerializedImageGeneration } from './queue';
it('task cancellation aborts active HTTP controllers and rejects queued work',async()=>{
 const task = new AbortController();
 await imageTaskContext.run(task.signal,async()=>{
  const request=new AbortController(); const unbind=bindImageTask(request);
  task.abort(new Error('cancelled'));
  expect(request.signal.aborted).toBe(true);
  expect(()=>checkImageTask()).toThrow('cancelled');
  unbind();
 });
 await expect(enqueueSerializedImageGeneration(()=>imageTaskContext.run(task.signal,async()=>{ checkImageTask(); return 'should not execute'; }))).rejects.toThrow('cancelled');
 expect(await enqueueSerializedImageGeneration(async()=> 'next task')).toBe('next task');
});

it('a slow local job does not block an independent cloud queue',async()=>{
 let finish!:()=>void;
 const local=enqueueSerializedImageGeneration(()=>new Promise<void>(resolve=>{finish=resolve;}));
 await Promise.resolve();
 expect(await enqueueSerializedImageGeneration(async()=> 'cloud result','https://image.test')).toBe('cloud result');
 finish(); await local;
});
