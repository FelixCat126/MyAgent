import type { RuntimeState } from './taskStore';
/** Video polling credentials stay sealed in ordinary state and are only opened inside the password-encrypted backup. */
export function revealPortableRuntimeSecrets(raw:RuntimeState,decrypt:(sealed:string)=>string):RuntimeState{
 const state=structuredClone(raw);
 for(const task of state.tasks){if(task.kind!=='video-generation'||!task.checkpoint)continue;const sealed=task.checkpoint.sealedApiKey;if(typeof sealed==='string'&&sealed){let plain:string;try{plain=decrypt(sealed);}catch{throw new Error('视频任务凭证无法在本机解密，请先更新服务配置');}task.checkpoint.portableApiKey=plain;delete task.checkpoint.sealedApiKey;}}
 return state;
}
export function protectPortableRuntimeSecrets(raw:RuntimeState,encrypt:(plain:string)=>string):RuntimeState{
 const state=structuredClone(raw);
 for(const task of state.tasks){if(task.kind!=='video-generation'||!task.checkpoint)continue;const plain=task.checkpoint.portableApiKey;if(typeof plain==='string'){task.checkpoint.sealedApiKey=encrypt(plain);delete task.checkpoint.portableApiKey;}}
 return state;
}
