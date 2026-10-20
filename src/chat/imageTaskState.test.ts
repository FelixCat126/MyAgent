import { expect, it } from 'vitest';
import { beginReplyRun, cancelReplyRun, forgetReplyRun, replyRunWasCancelled } from './imageTaskState';
it('a new turn cannot revive a stopped previous turn or cancel another session',()=>{
 beginReplyRun('s1','old'); beginReplyRun('s2','other');
 cancelReplyRun('s1'); beginReplyRun('s1','new');
 expect(replyRunWasCancelled('s1','old')).toBe(true);
 expect(replyRunWasCancelled('s1','new')).toBe(false);
 expect(replyRunWasCancelled('s2','other')).toBe(false);
});
it('regenerating the same user message does not revive the stopped run', () => {
 const stopped = beginReplyRun('s3', 'u1');
 cancelReplyRun('s3');
 const regenerated = beginReplyRun('s3', 'u1');
 expect(replyRunWasCancelled('s3', stopped)).toBe(true);
 expect(replyRunWasCancelled('s3', regenerated)).toBe(false);
});
it('forgetting a deleted session cancels its remaining run tokens', () => {
 const run = beginReplyRun('s4', 'u1');
 forgetReplyRun('s4');
 expect(replyRunWasCancelled('s4', run)).toBe(true);
});
