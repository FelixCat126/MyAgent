import { useCallback, useEffect, useRef, useState } from 'react';
import type { DictationKind, SpeechDictationOptions } from './types';

/**
 * 三条识别路径（web / api / volc）共享的状态与 ref 容器。
 * 路径 hook 只持有自身专有逻辑，交叉引用的载体全部收敛在此。
 */
export function useDictationShared({
  inputValueRef,
  textareaRef,
  setInput,
  getVolcAsrConfig,
  getApiTranscribeConfig,
  onDictationEnded,
}: SpeechDictationOptions) {
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const autoSendOnEndRef = useRef(false);
  const endNotifiedRef = useRef(false);
  const onDictationEndedRef = useRef(onDictationEnded);
  onDictationEndedRef.current = onDictationEnded;

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const committedRef = useRef('');
  const prefixRef = useRef('');
  const suffixRef = useRef('');
  const stopRequestedRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  /** 为 true 时 MediaRecorder.onstop 内丢弃转写结果（卸载 / 中止 / 切换会话） */
  const skipNextTranscriptRef = useRef(false);
  const dictationKindRef = useRef<DictationKind>('none');

  const getCfgRef = useRef(getApiTranscribeConfig);
  getCfgRef.current = getApiTranscribeConfig;
  const getVolcCfgRef = useRef(getVolcAsrConfig);
  getVolcCfgRef.current = getVolcAsrConfig;

  const clearBanner = useCallback(() => setBanner(null), []);

  /** 移动端失败提示不宜常驻：与对话区 RAG 错误条一致，数秒后自行消失 */
  useEffect(() => {
    if (!banner?.trim()) return;
    const tid = window.setTimeout(() => setBanner(null), 6500);
    return () => window.clearTimeout(tid);
  }, [banner]);

  const releaseMediaOnly = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordChunksRef.current = [];
  }, []);

  const captureAnchor = useCallback(() => {
    const ta = textareaRef.current;
    const snapshot = inputValueRef.current;
    if (!ta) return false;
    let startSel = ta.selectionStart;
    let endSel = ta.selectionEnd;
    if (startSel > endSel) [startSel, endSel] = [endSel, startSel];
    prefixRef.current = snapshot.slice(0, startSel);
    suffixRef.current = snapshot.slice(endSel);
    committedRef.current = '';
    stopRequestedRef.current = false;
    return true;
  }, [inputValueRef, textareaRef]);

  const finishDictationSession = useCallback(() => {
    if (endNotifiedRef.current) return;
    endNotifiedRef.current = true;
    const autoSend = autoSendOnEndRef.current;
    autoSendOnEndRef.current = false;
    const transcript = `${prefixRef.current}${committedRef.current}${suffixRef.current}`.trim();
    setListening(false);
    window.setTimeout(() => {
      onDictationEndedRef.current?.({ autoSend, transcript });
    }, 0);
  }, []);

  return {
    listening,
    starting,
    banner,
    setListening,
    setStarting,
    setBanner,
    autoSendOnEndRef,
    endNotifiedRef,
    onDictationEndedRef,
    recognitionRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    mediaRecorderRef,
    mediaStreamRef,
    recordChunksRef,
    skipNextTranscriptRef,
    dictationKindRef,
    getCfgRef,
    getVolcCfgRef,
    inputValueRef,
    textareaRef,
    setInput,
    clearBanner,
    releaseMediaOnly,
    captureAnchor,
    finishDictationSession,
  };
}

export type DictationShared = ReturnType<typeof useDictationShared>;
