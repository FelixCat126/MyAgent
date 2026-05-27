import { useEffect, useState } from 'react';

/**
 * 三态：unknown=检测中（首次渲染同步态）；available=至少有 1 个该类设备；missing=无任何设备或 enumerateDevices 不支持。
 *
 * 注意：浏览器在未授权时不会暴露 label，但仍会返回 kind 为 videoinput/audioinput 的占位条目；
 * 所以"是否物理存在硬件"用 enumerateDevices 判断已经足够。
 * 「无权限激活」由各业务流程内部处理（如 useGestureControl 的 permission-denied 状态），不在此判定。
 */
export type MediaInputKind = 'unknown' | 'available' | 'missing';

export interface MediaInputAvailability {
  camera: MediaInputKind;
  microphone: MediaInputKind;
}

/**
 * 启动时探测摄像头 / 麦克风是否物理可用，并跟随系统设备热插拔事件更新。
 * 用于禁用相关开关，避免在无硬件环境下被误激活后引发功能性 bug。
 */
export function useMediaInputAvailability(): MediaInputAvailability {
  const [state, setState] = useState<MediaInputAvailability>({
    camera: 'unknown',
    microphone: 'unknown',
  });

  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md || typeof md.enumerateDevices !== 'function') {
      setState({ camera: 'missing', microphone: 'missing' });
      return;
    }

    let alive = true;
    const probe = async (): Promise<void> => {
      try {
        const devices = await md.enumerateDevices();
        if (!alive) return;
        const hasCam = devices.some((d) => d.kind === 'videoinput');
        const hasMic = devices.some((d) => d.kind === 'audioinput');
        setState({
          camera: hasCam ? 'available' : 'missing',
          microphone: hasMic ? 'available' : 'missing',
        });
      } catch {
        if (!alive) return;
        setState({ camera: 'missing', microphone: 'missing' });
      }
    };
    void probe();

    const onChange = (): void => {
      void probe();
    };
    md.addEventListener?.('devicechange', onChange);
    return () => {
      alive = false;
      md.removeEventListener?.('devicechange', onChange);
    };
  }, []);

  return state;
}
