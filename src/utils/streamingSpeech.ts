import { stripMarkdownForSpeech, takeCompleteSentences } from './stripMarkdownForSpeech';
import { pickSpeakVoice, speechLangFromUiLocale, type SpeakVoicePick, waitForVoices } from './speechVoice';
import { speechSummary } from '../features/voiceQuick/speechSummary';
type VoicePick = { lang: string } & SpeakVoicePick;
async function loadVoicePick(locale: string): Promise<VoicePick | null> {
 const syn = typeof window !== 'undefined' ? window.speechSynthesis : null;if(!syn)return null;
 const lang=speechLangFromUiLocale(locale);const voices=await waitForVoices(syn);const pick=pickSpeakVoice(voices,lang);return pick?{lang,...pick}:null;
}
export type StreamingSpeechOptions = { onSpeakingChange?: (speaking: boolean) => void; mode?: 'auto'|'full'|'summary' };
/** Sentence-by-sentence speech; auto mode caps long answers, summary mode reads a short extract after completion. */
export class StreamingSpeechReader {
 private rawBuffer='';private spokenPlainIndex=0;private queue:string[]=[];private draining=false;private cancelled=false;private finished=false;private pick:VoicePick|null=null;
 private generation=0;private spokenCharacters=0;private summaryNoticeQueued=false;private releaseUtterance:(()=>void)|null=null;
 constructor(private readonly locale:string,private readonly opts:StreamingSpeechOptions={}){}
 async start():Promise<void>{this.cancel();const generation=++this.generation;this.cancelled=false;this.finished=false;this.rawBuffer='';this.spokenPlainIndex=0;this.spokenCharacters=0;this.summaryNoticeQueued=false;this.queue=[];this.draining=false;const pick=await loadVoicePick(this.locale);if(generation===this.generation&&!this.cancelled)this.pick=pick;}
 push(delta:string):void{
  if(this.cancelled||this.finished||!delta)return;this.rawBuffer+=delta;if(this.opts.mode==='summary')return;
  const plain=stripMarkdownForSpeech(this.rawBuffer),unspoken=plain.slice(this.spokenPlainIndex);if(!unspoken)return;
  const{sentences,remainder}=takeCompleteSentences(unspoken);this.spokenPlainIndex+=unspoken.length-remainder.length;
  for(const sentence of sentences){if(this.opts.mode!=='full'&&this.spokenCharacters+sentence.length>600){this.summaryNoticeQueued=true;break;}this.enqueue(sentence);this.spokenCharacters+=sentence.length;}
  void this.drainQueue();
 }
 finish():void{
  if(this.cancelled||this.finished)return;this.finished=true;
  if(this.opts.mode==='summary')this.enqueue(speechSummary(this.rawBuffer,460,this.locale));
  else{const plain=stripMarkdownForSpeech(this.rawBuffer),tail=plain.slice(this.spokenPlainIndex).trim();if(tail&&(this.opts.mode==='full'||this.spokenCharacters+tail.length<=600))this.enqueue(tail);else if(tail)this.summaryNoticeQueued=true;if(this.summaryNoticeQueued)this.queue.push(this.locale.startsWith('en')?'The full answer is available in the chat.':'完整回答已显示在对话中。');this.spokenPlainIndex=plain.length;}
  void this.drainQueue();
 }
 cancel():void{this.cancelled=true;this.generation++;this.queue=[];this.draining=false;this.releaseUtterance?.();this.releaseUtterance=null;try{window.speechSynthesis?.cancel();}catch{}this.opts.onSpeakingChange?.(false);}
 private enqueue(text:string):void{for(let index=0;index<text.length;index+=280)this.queue.push(text.slice(index,index+280));}
 private speakOne(text:string,pick:VoicePick):Promise<void>{if(typeof SpeechSynthesisUtterance==='undefined'||!window.speechSynthesis)return Promise.resolve();return new Promise(resolve=>{let settled=false;let watchdog:ReturnType<typeof setTimeout>|undefined;const utter=new SpeechSynthesisUtterance(text);utter.lang=pick.lang;if(pick.voice)utter.voice=pick.voice;utter.rate=.96;utter.pitch=1;const finish=()=>{if(settled)return;settled=true;if(watchdog)clearTimeout(watchdog);if(this.releaseUtterance===finish)this.releaseUtterance=null;resolve();};this.releaseUtterance=finish;utter.onend=finish;utter.onerror=finish;watchdog=setTimeout(()=>{try{window.speechSynthesis.cancel();}catch{}finish();},Math.max(10000,Math.min(120000,text.length*260)));window.speechSynthesis.speak(utter);});}
 private async drainQueue():Promise<void>{
  if(this.draining||this.cancelled)return;this.draining=true;const generation=this.generation;
  try{while(this.queue.length&&!this.cancelled&&generation===this.generation){const segment=this.queue.shift();if(!segment?.trim())continue;const pick=this.pick??await loadVoicePick(this.locale);if(!pick||this.cancelled||generation!==this.generation)break;this.pick=pick;this.opts.onSpeakingChange?.(true);await this.speakOne(segment.trim(),pick);}}
  catch{if(generation===this.generation){this.cancelled=true;this.queue=[];}}
  finally{if(generation===this.generation){this.draining=false;this.opts.onSpeakingChange?.(false);if(this.queue.length&&!this.cancelled)void this.drainQueue();}}
 }
}
