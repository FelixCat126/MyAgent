// @vitest-environment node
import { beforeEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({connect:vi.fn(),calls:vi.fn(),close:vi.fn(),tools:[{name:'read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'write',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]}));
vi.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:class{async connect(){return mocks.connect();}async close(){return mocks.close();}async listTools(){return{tools:mocks.tools};}async callTool(params:unknown,_schema:unknown,options:{signal:AbortSignal}){return mocks.calls(params,options);}}}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js',()=>({StreamableHTTPClientTransport:class{}}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js',()=>({StdioClientTransport:class{},getDefaultEnvironment:()=>({PATH:'/bin'})}));
import {McpManager} from './mcpManager';
beforeEach(()=>{mocks.connect.mockReset();mocks.calls.mockReset();mocks.close.mockReset();mocks.calls.mockResolvedValue({content:[{type:'text',text:'ok'}]});});
describe('MCP approval and lifecycle',()=>{
  it('requires one-use approval for mutations and never automatically calls them',async()=>{const manager=new McpManager();await manager.connect({id:'one',name:'test',transport:'http',url:'https://example.com/mcp',enabled:false});const requested=await manager.call('one','write',{value:2});expect(requested.authorizationRequired).toBeDefined();expect(mocks.calls).not.toHaveBeenCalled();await manager.approve(requested.authorizationRequired!.id);expect(mocks.calls).toHaveBeenCalledOnce();await expect(manager.approve(requested.authorizationRequired!.id)).rejects.toThrow('失效');await manager.shutdown();});
  it('read-only calls execute and disconnect cancels active calls and approvals',async()=>{const manager=new McpManager();await manager.connect({id:'one',name:'test',transport:'http',url:'https://example.com/mcp',enabled:false});const requested=await manager.call('one','write',{});await manager.disconnect('one');await expect(manager.approve(requested.authorizationRequired!.id)).rejects.toThrow('失效');await manager.connect({id:'one',name:'test',transport:'http',url:'https://example.com/mcp',enabled:false});let signal:AbortSignal|undefined;mocks.calls.mockImplementation((_params,options)=>new Promise((_,reject)=>{signal=options.signal;signal!.addEventListener('abort',()=>reject(new Error('cancelled')));}));const response=manager.call('one','read',{});await new Promise(resolve=>setTimeout(resolve,0));await manager.disconnect('one');expect(signal?.aborted).toBe(true);expect((await response).error).toBe('cancelled');});
  it('refuses to send credentials over remote plaintext HTTP',async()=>{const manager=new McpManager();await expect(manager.connect({id:'one',name:'test',transport:'http',url:'http://example.com/mcp',token:'private',enabled:false})).rejects.toThrow('HTTPS');});
  it('closes all established connections concurrently and waits for every close',async()=>{
    const manager=new McpManager();
    for(const id of ['one','two','three'])await manager.connect({id,name:id,transport:'http',url:'https://example.com/mcp',enabled:false});
    const resolvers:Array<()=>void>=[];
    mocks.close.mockImplementation(()=>new Promise<void>(resolve=>resolvers.push(resolve)));
    let settled=false;const closing=manager.shutdown().then(()=>{settled=true;});
    expect(mocks.close).toHaveBeenCalledTimes(3);expect(settled).toBe(false);
    resolvers[0]();resolvers[1]();await Promise.resolve();expect(settled).toBe(false);
    resolvers[2]();await closing;expect(settled).toBe(true);
  });
  it('closes a connection that is still opening and revokes its late completion',async()=>{
    let connected!:()=>void;
    mocks.connect.mockImplementation(()=>new Promise<void>(resolve=>{connected=resolve;}));
    const manager=new McpManager();
    const pending=manager.connect({id:'opening',name:'pending',transport:'http',url:'https://example.com/mcp',enabled:false});
    const rejected=expect(pending).rejects.toThrow('撤销');
    await manager.shutdown();expect(mocks.close).toHaveBeenCalledOnce();
    connected();await rejected;expect(manager.connected('opening')).toBe(false);
  });
});
