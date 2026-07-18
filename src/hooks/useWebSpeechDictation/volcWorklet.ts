export const VOLC_CHUNK_SAMPLES = 3200;
/** 待发送 PCM 队列上限，防止 IPC 阻塞时数组无限增长 */
export const VOLC_MAX_PENDING_SAMPLES = VOLC_CHUNK_SAMPLES * 24;

/** 避免 ScriptProcessor（已废弃）：在 Electron/macOS 上有诱发渲染进程崩溃的风险，改用 AudioWorklet */
export const VOLC_PCM_TAP_PROCESSOR = 'volc-pcm-tap-v1';

const VOLC_PCM_WORKLET_CODE = `
class VolcPcmTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const ch0 = inputs[0]?.[0];
    if (ch0 && ch0.length > 0) {
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    const out0 = outputs[0]?.[0];
    if (out0 && out0.length) out0.fill(0);
    return true;
  }
}
registerProcessor("${VOLC_PCM_TAP_PROCESSOR}", VolcPcmTapProcessor);
`;

export async function addVolcPcmTapWorklet(audioCtx: AudioContext): Promise<void> {
  const blob = new Blob([VOLC_PCM_WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await audioCtx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
