import { expect, it } from 'vitest';
import { beginReplyRun, cancelReplyRun, replyRunWasCancelled } from './imageTaskState';
it('a new turn cannot revive a stopped previous turn or cancel another session',()=>{
 beginReplyRun('s1','old'); beginReplyRun('s2','other');
 cancelReplyRun('s1'); beginReplyRun('s1','new');
 expect(replyRunWasCancelled('s1','old')).toBe(true);
 expect(replyRunWasCancelled('s1','new')).toBe(false);
 expect(replyRunWasCancelled('s2','other')).toBe(false);
});
