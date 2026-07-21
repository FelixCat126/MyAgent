/**
 * MediaPipe 引导共享：模型字节流归一化 + tasks-vision fileset 装配。
 * useGestureControl（手势）与 useFaceTracking（视线/眨眼）曾各持一份逐字拷贝。
 */

/** IPC 返回的模型 data 可能是 Uint8Array / { buffer } / ArrayBuffer，统一归一化 */
export function toModelBuffer(raw: unknown): Uint8Array {
  return raw instanceof Uint8Array
    ? raw
    : raw && typeof raw === 'object' && 'buffer' in (raw as { buffer?: ArrayBuffer })
      ? new Uint8Array((raw as { buffer: ArrayBuffer }).buffer)
      : new Uint8Array(raw as ArrayBuffer);
}

/** 动态导入 tasks-vision 并装配 wasm fileset（wasm 静态资源随包分发到 ./mediapipe-wasm/） */
export async function createVisionFileset() {
  const wasmBaseUrl = new URL('./mediapipe-wasm/', window.location.href).href;
  const visionMod = await import('@mediapipe/tasks-vision');
  const fileset = await visionMod.FilesetResolver.forVisionTasks(wasmBaseUrl);
  return { visionMod, fileset };
}
