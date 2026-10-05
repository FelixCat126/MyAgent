// @vitest-environment node
import { describe,it,expect } from 'vitest';
import {McpManager} from './mcpManager';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
describe('MCP actual stdio protocol',()=>{
 it('initializes a real local server, discovers tools, reads, and requires approval before writes',async()=>{const dir=await fs.mkdtemp(path.join(tmpdir(),'myagent-mcp-'));const marker=path.join(dir,'written.txt');const script=`import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import fs from 'node:fs/promises';const server=new McpServer({name:'test',version:'1'});server.registerTool('read',{description:'read-only',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:'live result'}]}));server.registerTool('write',{description:'mutation',inputSchema:{}},async()=>{await fs.writeFile(${JSON.stringify(marker)},'done');return{content:[{type:'text',text:'written'}]};});await server.connect(new StdioServerTransport());`;
 const manager=new McpManager();try{const tools=await manager.connect({id:'local',name:'test',transport:'stdio',command:process.execPath,args:['--input-type=module','-e',script],enabled:false});expect(tools.map(t=>t.name)).toEqual(['read','write']);expect((await manager.call('local','read',{})).result).toMatchObject({content:[{text:'live result'}]});const approval=await manager.call('local','write',{});await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});await manager.approve(approval.authorizationRequired!.id);expect(await fs.readFile(marker,'utf8')).toBe('done');}finally{await manager.shutdown();await fs.rm(dir,{recursive:true,force:true});}},10000);
});
