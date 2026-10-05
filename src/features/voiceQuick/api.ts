export interface QuickRequest { id: string; text: string }
export interface QuickUpdate { id: string; status: 'running'|'completed'|'failed'|'cancelled'; content?: string; sessionId?: string; files?: Array<{name:string}>; error?: string }
export interface VoiceQuickAPI {
  showQuickPanel(): Promise<{ available:boolean }>;
  quickReplyUpdate(update: QuickUpdate): Promise<void>;
  onQuickSubmit(callback:(request:QuickRequest)=>void):()=>void;
  onQuickCancel(callback:(id:string)=>void):()=>void;
  onQuickOpenSession(callback:(sessionId:string)=>void):()=>void;
}
