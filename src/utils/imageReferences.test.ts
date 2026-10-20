import { expect, it } from 'vitest';
import { resolveImageReferences } from './imageReferences';
import type { Message } from '../types';
const message = (content:string, paths:string[]=[]):Message => ({id:'x',role:'user',content,timestamp:0,model:'x',files:paths.map(path=>({name:path,path,size:1,type:'image/png'}))});
it('resolves an ordinal in the last image group and rejects invalid selection',()=>{
 const history=[message('images',['/first','/second'])];
 expect(resolveImageReferences(message('把第二张背景改白'),history)).toEqual(['/second']);
 expect(()=>resolveImageReferences(message('把第三张背景改白'),history)).toThrow('只有 2 张');
 expect(resolveImageReferences(message('生成一张雪山图'),history)).toEqual([]);
 expect(resolveImageReferences(message('修改上一张图',['/attached']),history)).toEqual(['/attached']);
 expect(resolveImageReferences(message('背景换成蓝色'),history)).toEqual(['/second']);
});
it('does not turn ordinary style words into reference edits or fail without history',()=>{
 const history=[message('images',['/first'])];
 for (const text of ['画一只猫，保持简约风格','生成海报，保留大量留白','画一个 code editor 界面','生成一张参考书封面']) expect(resolveImageReferences(message(text),history),text).toEqual([]);
 expect(resolveImageReferences(message('背景换成蓝色'),[])).toEqual([]);
 expect(()=>resolveImageReferences(message('把上一张背景改白'),[])).toThrow('没有找到要修改的图片');
});
