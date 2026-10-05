import {describe,it,expect} from 'vitest';
import {speechSummary} from './speechSummary';
describe('spoken extracts',()=>{
 it('preserves short answers and removes code and Markdown decoration',()=>{expect(speechSummary('**结论**：可以。\n```js\nthrow 1\n```')).toBe('结论：可以。');});
 it('limits a long answer to original sentences and marks it as an extract',()=>{const answer=Array.from({length:30},(_,i)=>`这是第${i+1}项结果，需要结合实际资料进行判断。`).join('');const result=speechSummary(answer,200);expect(result.length).toBeLessThanOrEqual(200);expect(result).toContain('简要朗读');expect(result).toContain('完整回答');expect(result).not.toContain('这是第15项');});
});
