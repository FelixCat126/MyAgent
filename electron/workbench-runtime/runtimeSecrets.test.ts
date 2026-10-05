// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {revealPortableRuntimeSecrets,protectPortableRuntimeSecrets} from './runtimeSecrets';
import {emptyState} from './taskStore';
describe('portable task credentials',()=>{
 it('reseals video keys on another machine without leaking them into normal task state',()=>{const state=emptyState();state.tasks.push({id:'one',title:'video',kind:'video-generation',status:'interrupted',steps:[],checkpoint:{remoteJobId:'remote',sealedApiKey:'machine-a-cipher'},createdAt:1,updatedAt:1});const exported=revealPortableRuntimeSecrets(state,sealed=>sealed==='machine-a-cipher'?'live-api-key':'');expect(exported.tasks[0].checkpoint).toEqual({remoteJobId:'remote',portableApiKey:'live-api-key'});const imported=protectPortableRuntimeSecrets(exported,plain=>`machine-b:${plain.length}`);expect(imported.tasks[0].checkpoint).toEqual({remoteJobId:'remote',sealedApiKey:'machine-b:12'});expect(state.tasks[0].checkpoint?.sealedApiKey).toBe('machine-a-cipher');expect(JSON.stringify(imported)).not.toContain('live-api-key');});
 it('refuses a portable export if the original machine cannot decrypt the polling key',()=>{const state=emptyState();state.tasks.push({id:'one',title:'video',kind:'video-generation',status:'failed',steps:[],checkpoint:{sealedApiKey:'bad'},createdAt:1,updatedAt:1});expect(()=>revealPortableRuntimeSecrets(state,()=>{throw new Error('locked');})).toThrow('无法');});
});
