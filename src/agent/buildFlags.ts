/** 构建时可通过 VITE_AGENT_TOOLS=0 完全关闭 Agent 能力（无 UI、无 IPC 调用） */
export function isAgentToolsBuildEnabled(): boolean {
  return import.meta.env.VITE_AGENT_TOOLS !== '0';
}
