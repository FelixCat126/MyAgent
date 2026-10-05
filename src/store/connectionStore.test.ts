import { beforeEach, describe, expect, it } from 'vitest';
import { useConnectionStore, resolveModelConnection, validateConnection, modelCapabilitySignature, hasCurrentCapability } from './connectionStore';
import type { ModelConfig } from '../types';
const model: ModelConfig = { id: 'm', name: 'm', provider: 'custom', apiUrl: 'https://old.example/v1', apiKey: 'old', modelName: 'test', isLocal: false, maxTokens: 100 };
describe('shared model connections', () => {
  beforeEach(() => useConnectionStore.setState({ connections: [] }));
  it('does not alter legacy models', () => expect(resolveModelConnection(model)).toBe(model));
  it('resolves shared credentials and invalidates capability proof after edit', () => {
    useConnectionStore.getState().saveConnection({ id:'c', name:'local', provider:'ollama', apiUrl:'http://localhost:11434', apiKey:'', chatApiMode:'auto' });
    const linked = {...model, connectionId:'c'};
    const verified = {...linked, capabilities:{checkedAt:Date.now(),signature:modelCapabilitySignature(linked),tools:'verified' as const}};
    expect(resolveModelConnection(linked).isLocal).toBe(true);
    expect(hasCurrentCapability(verified,'tools')).toBe(true);
    useConnectionStore.getState().saveConnection({id:'c',name:'local',provider:'ollama',apiUrl:'http://localhost:11435',apiKey:'',chatApiMode:'auto'});
    expect(hasCurrentCapability(verified,'tools')).toBeUndefined();
  });
  it('rejects credentials embedded in URLs and preserves detached fallback', () => {
    expect(validateConnection({name:'x',apiUrl:'https://user:pass@host/v1'})).toBeTruthy();
    expect(resolveModelConnection({...model,connectionId:'missing'}).apiKey).toBe('old');
  });
  it('retains independent video credentials and explicit local policy while sharing chat auth', () => {
    useConnectionStore.getState().saveConnection({id:'shared',name:'fixture',provider:'custom',apiUrl:'http://127.0.0.1:8000/v1',apiKey:'chat',chatApiMode:'openai',isLocal:false});
    const independent={...model,connectionId:'shared',videoGeneratorConfig:{provider:'custom',model:'video',apiKey:'video-independent'}};
    expect(resolveModelConnection(independent).videoGeneratorConfig?.apiKey).toBe('video-independent');expect(resolveModelConnection(independent).isLocal).toBe(false);
    expect(resolveModelConnection({...independent,videoGeneratorConfig:{...independent.videoGeneratorConfig,apiKey:undefined}}).videoGeneratorConfig?.apiKey).toBe('chat');
  });
  it('resolves a separate video service without changing chat settings and preserves dangling video fallback', () => {
    useConnectionStore.setState({connections:[{id:'chat',name:'chat',provider:'openai',apiUrl:'https://chat.example/v1',apiKey:'chat-key',chatApiMode:'openai',updatedAt:1},{id:'video',name:'video',provider:'custom',apiUrl:'https://video.example',apiKey:'video-key',chatApiMode:'auto',updatedAt:1}]});
    const combined={...model,connectionId:'chat',videoGeneratorConfig:{connectionId:'video',provider:'custom',model:'video-model',endpoint:'https://video.example/submit',apiKey:'video-fallback'}};
    const resolved=resolveModelConnection(combined);expect(resolved.apiKey).toBe('chat-key');expect(resolved.apiUrl).toBe('https://chat.example/v1');expect(resolved.videoGeneratorConfig?.apiKey).toBe('video-key');expect(resolved.videoGeneratorConfig?.endpoint).toBe('https://video.example/submit');
    expect(resolveModelConnection({...combined,connectionId:undefined}).videoGeneratorConfig?.apiKey).toBe('video-key');
    expect(resolveModelConnection({...combined,videoGeneratorConfig:{...combined.videoGeneratorConfig,connectionId:'missing'}}).videoGeneratorConfig?.apiKey).toBe('video-fallback');
    expect(resolveModelConnection({...combined,videoGeneratorConfig:{...combined.videoGeneratorConfig,connectionId:'missing',apiKey:undefined}}).videoGeneratorConfig?.apiKey).toBeUndefined();
  });
});
