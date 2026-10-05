import { describe, expect, it } from 'vitest';
import { extractContextAnchors } from './contextAnchors';
import type { Message } from '../types';
const msg=(content:string,id='u'):Message=>({id,role:'user',content,timestamp:1,model:'fixture'});
describe('context anchor preservation',()=>{
 it('retains exact numeric units, dates, named files and decisions',()=>{const anchors=extractContextAnchors([msg('预算确认 12800 元。交付日期 2026-10-12。必须保留 weekly.xlsx 和文件原始数据。')]);expect(anchors).toContain('12800 元');expect(anchors).toContain('2026-10-12');expect(anchors).toContain('weekly.xlsx');expect(anchors).toContain('必须保留');});
 it('prefers current user decisions within a bounded budget and marks excerpts as historical data',()=>{const anchors=extractContextAnchors([msg('旧数字 10元','old'),msg('以后回答必须使用中文','new')],40);expect(anchors).toContain('[user new]');expect(anchors.length).toBeLessThanOrEqual(40);});
});
