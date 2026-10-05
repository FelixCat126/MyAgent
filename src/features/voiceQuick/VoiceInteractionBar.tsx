import {useSettingStore} from '../../store/settingStore';
import {FiMic,FiVolume2,FiSquare,FiLoader} from 'react-icons/fi';
export interface VoiceInteractionBarProps { enabled:boolean; listening:boolean; starting:boolean; thinking:boolean; speaking:boolean; wakeListening:boolean; wakePhrase:string; supported:boolean; paused?:boolean; onResume?:()=>void; onInterrupt:()=>void; onStop:()=>void }
export function VoiceInteractionBar(props:VoiceInteractionBarProps){
 const en=useSettingStore(state=>state.locale)==='en';
 if(!props.enabled)return null;
 const state=props.paused?'语音已暂停':props.starting?'正在连接麦克风':props.listening?'正在听写':props.speaking?'正在朗读':props.thinking?'正在思考与处理':props.wakeListening?`等待唤醒 · ${props.wakePhrase}`:'语音待命';
 const labels:Record<string,string>={'语音已暂停':'Voice paused','正在连接麦克风':'Connecting microphone','正在听写':'Dictating','正在朗读':'Speaking','正在思考与处理':'Thinking and working','语音待命':'Voice ready'};
 const display=en?(labels[state]||`Awaiting wake phrase · ${props.wakePhrase}`):state;
 const active=props.starting||props.listening||props.speaking||props.thinking||props.wakeListening;
 const Icon=props.starting||props.thinking?FiLoader:props.speaking?FiVolume2:FiMic;
 return <div className="mx-4 mb-1 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300" aria-live="polite"><span className="flex items-center gap-2"><Icon className={props.starting||props.thinking?'animate-spin':''}/>{display}</span><div className="flex items-center gap-2">{props.paused&&<button type="button" onClick={props.onResume} className="rounded-md px-2 py-1 text-primary-600 dark:text-primary-300">{en?'Resume voice':'恢复语音'}</button>}{(props.thinking||props.speaking)&&props.supported&&<button type="button" onClick={props.onInterrupt} className="rounded-md px-2 py-1 text-primary-600 hover:bg-primary-100 dark:text-primary-300 dark:hover:bg-slate-700">{en?'Interrupt and dictate':'打断并听写'}</button>}{active&&<button type="button" onClick={props.onStop} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-stone-200 dark:hover:bg-slate-700"><FiSquare size={11}/>{en?'Stop voice':'停止语音'}</button>}</div></div>;
}
