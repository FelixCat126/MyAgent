import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PERSIST_KEYS } from '../utils/persistKeys';
import { zustandPersistJson } from '../utils/zustandFileStorage';

/**
 * 视线校准状态：
 *  - matrix：拟合好的 2×5 仿射变换（行优先 10 元数组）；为 null 时 GazeIndicator 走启发式 fallback
 *  - lastCalibratedAt：上次完成校准的时间戳，便于显示与失效判断（屏幕分辨率变化时手动重校）
 *  - viewportSnapshot：校准时的视口宽高，分辨率不一致时提示重校
 *
 * 仅持久化拟合结果与元数据，不持久化采样过程数据。
 */
export interface GazeCalibrationState {
  matrix: number[] | null;
  lastCalibratedAt: number;
  viewportSnapshot: { w: number; h: number } | null;
  setCalibration: (m: number[], viewport: { w: number; h: number }) => void;
  clearCalibration: () => void;
}

export const useGazeCalibrationStore = create<GazeCalibrationState>()(
  persist(
    (set) => ({
      matrix: null,
      lastCalibratedAt: 0,
      viewportSnapshot: null,
      setCalibration: (m, viewport) =>
        set({
          matrix: m,
          lastCalibratedAt: Date.now(),
          viewportSnapshot: { w: viewport.w, h: viewport.h },
        }),
      clearCalibration: () =>
        set({ matrix: null, lastCalibratedAt: 0, viewportSnapshot: null }),
    }),
    {
      name: PERSIST_KEYS.gazeCalibration,
      version: 1,
      storage: zustandPersistJson,
    },
  ),
);
