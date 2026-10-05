import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('./speechVoice',()=>({speechLangFromUiLocale:()=> 'zh-CN',waitForVoices:async()=>[],pickSpeakVoice:()=>({voice:null})}));
import {StreamingSpeechReader} from './streamingSpeech';
class TestUtterance {onend:(()=>void)|null=null;onerror:(()=>void)|null=null;lang='';rate=1;pitch=1;voice=null;constructor(public text:string){}}
afterEach(()=>vi.unstubAllGlobals());
function stubSpeech(autoEnd=true){const spoken:TestUtterance[]=[];vi.stubGlobal('SpeechSynthesisUtterance',TestUtterance);const cancel=vi.fn();Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel,speak:(utter:TestUtterance)=>{spoken.push(utter);if(autoEnd)queueMicrotask(()=>utter.onend?.());}}});return{spoken,cancel};}
async function flush(){for(let i=0;i<300;i++)await Promise.resolve();}
describe('speech stream lifecycle',()=>{
 it('summary mode waits for complete text then reads a bounded extract',async()=>{const{spoken}=stubSpeech();const reader=new StreamingSpeechReader('zh',{mode:'summary'});await reader.start();reader.push('这是结论。'.repeat(200));await flush();expect(spoken).toHaveLength(0);reader.finish();await flush();expect(spoken.map(u=>u.text).join('')).toContain('简要朗读');expect(spoken.map(u=>u.text).join('').length).toBeLessThanOrEqual(460);});
 it('auto mode caps long speech while full mode keeps all text',async()=>{let{spoken}=stubSpeech();const text='这是一条需要阅读的完整结果。'.repeat(80);const auto=new StreamingSpeechReader('zh',{mode:'auto'});await auto.start();auto.push(text);auto.finish();await flush();expect(spoken.map(u=>u.text).join('').length).toBeLessThan(700);({spoken}=stubSpeech());const full=new StreamingSpeechReader('zh',{mode:'full'});await full.start();full.push(text);full.finish();await flush();expect(spoken.map(u=>u.text).join('')).toBe(text);});
 it('cancellation resolves an utterance even when the engine emits no end event',async()=>{const{spoken,cancel}=stubSpeech(false);const speaking=vi.fn();const reader=new StreamingSpeechReader('zh',{onSpeakingChange:speaking});await reader.start();reader.push('第一条回答。');await flush();expect(spoken).toHaveLength(1);reader.cancel();await flush();expect(cancel).toHaveBeenCalled();expect(speaking).toHaveBeenLastCalledWith(false);reader.push('取消后绝不继续。');reader.finish();await flush();expect(spoken).toHaveLength(1);});
});
