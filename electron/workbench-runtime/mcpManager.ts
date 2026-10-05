import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpConnection, McpTool, McpCallResult, JsonObject } from '../../src/features/runtime/api';

const CALL_TIMEOUT = 30_000;
export class McpManager {
  private clients = new Map<string, Client>();
  private tools = new Map<string, McpTool[]>();
  private approvals = new Map<string, { connectionId: string; tool: string; args: JsonObject; expiresAt: number }>();
  private calls = new Map<string, AbortController>();
  private callConnections = new Map<string,string>();
  private connecting = new Map<string, Promise<McpTool[]>>();
  private openingClients = new Map<string, Client>();
  private generations = new Map<string, number>();
  async connect(connection: McpConnection): Promise<McpTool[]> {
    if (this.clients.has(connection.id)) return this.listTools(connection.id);
    const pending = this.connecting.get(connection.id); if (pending) return pending;
    const promise = this.open(connection); this.connecting.set(connection.id, promise);
    try { return await promise; } finally { if (this.connecting.get(connection.id) === promise) this.connecting.delete(connection.id); }
  }
  private async open(connection: McpConnection): Promise<McpTool[]> {
    const generation = this.generations.get(connection.id) || 0;
    const client = new Client({ name: 'MyAgent', version: '1.2.0' }, { capabilities: {} });
    let transport;
    if (connection.transport === 'http') {
      const url = new URL(connection.url || '');
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP 地址必须为不带内嵌凭证的 HTTP/HTTPS 地址');
      if (connection.token && url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('带凭证的远程 MCP 服务必须使用 HTTPS');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {} } });
    } else {
      if (!connection.command?.trim() || /[\r\n\0]/.test(connection.command)) throw new Error('请输入可执行程序路径或名称');
      if (!Array.isArray(connection.args) || connection.args.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('启动参数无效');
      transport = new StdioClientTransport({ command: connection.command, args: connection.args, env: { ...getDefaultEnvironment(), ...(connection.env || {}) }, stderr: 'ignore' });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.openingClients.set(connection.id, client);
    try {
      await Promise.race([client.connect(transport), new Promise<never>((_, reject) => { timer = setTimeout(() => { void client.close(); reject(new Error('MCP 连接超时（20 秒）')); }, 20_000); })]);
      if (generation !== (this.generations.get(connection.id) || 0)) throw new Error('连接已撤销');
      this.clients.set(connection.id, client);
      return await this.listTools(connection.id);
    } catch (error) { await client.close().catch(() => undefined); if (this.clients.get(connection.id) === client) this.clients.delete(connection.id); throw error; }
    finally { if (timer) clearTimeout(timer); if (this.openingClients.get(connection.id) === client) this.openingClients.delete(connection.id); }
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    for (const [approvalId, item] of this.approvals) if (item.connectionId === id) this.approvals.delete(approvalId);
    for (const [callId, controller] of this.calls) if (callId.startsWith(`${id}:`) || this.callConnections.get(callId) === id) { controller.abort(); this.calls.delete(callId); }
    const client = this.clients.get(id) || this.openingClients.get(id); this.clients.delete(id); this.openingClients.delete(id); this.tools.delete(id);
    if (client) await client.close();
  }
  connected(id: string): boolean { return this.clients.has(id); }
  async listTools(id: string): Promise<McpTool[]> {
    const client = this.clients.get(id); if (!client) throw new Error('MCP 尚未连接');
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const response = await client.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT });
      tools.push(...response.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as JsonObject, readOnly: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint !== false })));
      if (tools.length > 1000) throw new Error('MCP 工具数量超过 1000');
      cursor = response.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP 工具分页重复');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.tools.set(id, tools); return tools;
  }
  async call(connectionId: string, toolName: string, args: JsonObject): Promise<McpCallResult> {
    if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw new Error('工具参数超过 1 MB');
    const available = this.tools.get(connectionId) || await this.listTools(connectionId);
    const tool = available.find(t => t.name === toolName); if (!tool) throw new Error('工具不存在');
    if (!tool.readOnly) {
      // An MCP annotation is only a hint. Every unmarked or mutating tool requires a one-use click approval.
      const id = randomUUID(); const value = { connectionId, tool: toolName, args: structuredClone(args), expiresAt: Date.now() + 5 * 60_000 };
      this.approvals.set(id, value); return { authorizationRequired: { id, ...value } };
    }
    return this.execute(connectionId, toolName, args);
  }
  async approve(id: string): Promise<McpCallResult> {
    const item = this.approvals.get(id); this.approvals.delete(id);
    if (!item || item.expiresAt < Date.now()) throw new Error('授权已失效，请重新发起工具调用');
    return this.execute(item.connectionId, item.tool, item.args, id);
  }
  pendingCalls():NonNullable<McpCallResult['authorizationRequired']>[] {
    const now=Date.now();for(const [id,item] of this.approvals)if(item.expiresAt<now)this.approvals.delete(id);
    return [...this.approvals].map(([id,item])=>({id,...structuredClone(item)}));
  }
  async cancel(id: string): Promise<void> { this.approvals.delete(id); this.calls.get(id)?.abort(); }
  private async execute(connectionId: string, name: string, args: JsonObject, approvalId?: string): Promise<McpCallResult> {
    const client = this.clients.get(connectionId); if (!client) throw new Error('连接已断开，请重新连接');
    const callId = approvalId || `${connectionId}:${randomUUID()}`; const controller = new AbortController(); this.calls.set(callId, controller); this.callConnections.set(callId, connectionId);
    try { return { result: await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT, signal: controller.signal }) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    finally { this.calls.delete(callId); this.callConnections.delete(callId); }
  }
  async shutdown(): Promise<void> { const ids = new Set([...this.clients.keys(), ...this.openingClients.keys(), ...this.connecting.keys()]); await Promise.allSettled([...ids].map(id => this.disconnect(id))); }
}
