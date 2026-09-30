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
});
