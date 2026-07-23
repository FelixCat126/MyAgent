import { describe, it, expect } from 'vitest';
import {
  GAZE_FEATURE_DIM,
  gazeFeatureVector,
  solveAffineLeastSquares,
  applyGazeAffine,
} from './gazeFit';

describe('gazeFit', () => {
  it('gazeFeatureVector 维度固定', () => {
    const f = gazeFeatureVector({ gx: 0.1, gy: 0.2, yaw: 0.01, pitch: -0.02 });
    expect(f).toHaveLength(GAZE_FEATURE_DIM);
    expect(f[0]).toBe(1);
  });

  it('样本充足时 solve 返回有限矩阵，apply 输出有限坐标', () => {
    const samples = [
      { feat: gazeFeatureVector({ gx: 0, gy: 0, yaw: 0, pitch: 0 }), screen: { x: 10, y: 20 } },
      { feat: gazeFeatureVector({ gx: 0.5, gy: 0, yaw: 0.1, pitch: 0 }), screen: { x: 100, y: 20 } },
      { feat: gazeFeatureVector({ gx: 0, gy: 0.5, yaw: 0, pitch: 0.1 }), screen: { x: 10, y: 200 } },
      { feat: gazeFeatureVector({ gx: 0.5, gy: 0.5, yaw: 0.1, pitch: 0.1 }), screen: { x: 100, y: 200 } },
      { feat: gazeFeatureVector({ gx: 0.25, gy: 0.25, yaw: 0.05, pitch: 0.05 }), screen: { x: 55, y: 110 } },
    ];
    const A = solveAffineLeastSquares(
      samples.map((s) => s.feat),
      samples.map((s) => s.screen)
    );
    expect(A).not.toBeNull();
    expect(A!).toHaveLength(GAZE_FEATURE_DIM * 2);
    expect(A!.every((n) => Number.isFinite(n))).toBe(true);
    const p = applyGazeAffine(A!, samples[0]!.feat);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});
