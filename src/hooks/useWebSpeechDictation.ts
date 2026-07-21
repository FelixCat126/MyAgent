/**
 * 语音听写（973 行状态机的拆分后的兼容桶文件）。
 * 实现见 ./useWebSpeechDictation/ 目录；外部导入路径保持不变。
 */
export { useWebSpeechDictation } from './useWebSpeechDictation/index';
export { getRecognitionCtor, hasVolcAsrStack, volcCredsConfigured } from './useWebSpeechDictation/stacks';
export {
  addVolcPcmTapWorklet,
  VOLC_CHUNK_SAMPLES,
  VOLC_MAX_PENDING_SAMPLES,
  VOLC_PCM_TAP_PROCESSOR,
} from './useWebSpeechDictation/volcWorklet';
export type {
  SpeechApiTranscribeConfig,
  SpeechDictationEndedDetail,
  SpeechDictationLabels,
  SpeechDictationStartOptions,
  VolcAsrDictationConfig,
} from './useWebSpeechDictation/types';
