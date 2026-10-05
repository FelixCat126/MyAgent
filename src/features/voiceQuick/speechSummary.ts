import {stripMarkdownForSpeech,takeCompleteSentences} from '../../utils/stripMarkdownForSpeech';
/** Extract complete sentences from the beginning and conclusion. Never invent model claims. */
export function speechSummary(raw:string,maximum=460,locale='zh'):string{
 const plain=stripMarkdownForSpeech(raw).trim();if(plain.length<=maximum)return plain;
 const {sentences,remainder}=takeCompleteSentences(plain);const all=[...sentences,...(remainder?[remainder]:[])].map(s=>s.trim()).filter(Boolean);
 const prefix=locale.startsWith('en')?'Brief reading: ':'简要朗读：';const suffix=locale.startsWith('en')?' The full answer is available in the chat.':' 完整回答已显示在对话中。';const budget=Math.max(1,maximum-prefix.length-suffix.length);
 const chosen:string[]=[];let length=0;
 for(const sentence of all.slice(0,3)){const addition=sentence.length+(length?1:0);if(length+addition>budget-40)break;chosen.push(sentence);length+=addition;}
 const conclusion=all.at(-1);if(conclusion&&chosen.length&& !chosen.includes(conclusion)&&length+1+conclusion.length<=budget)chosen.push(conclusion);
 let excerpt=chosen.join(' ');if(!excerpt)excerpt=plain.slice(0,budget).replace(/[^。！？.!?]*$/,'').trim()||plain.slice(0,budget);
 return `${prefix}${excerpt}${suffix}`;
}
