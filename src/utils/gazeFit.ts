/**
 * 视线校准 — 最小二乘拟合工具。
 *
 * 设计：
 *  - 输入特征向量 x = [1, gx, gy, yaw, pitch]ᵀ（5 维），输出屏幕像素 y = (sx, sy)ᵀ
 *  - 目标矩阵 A ∈ R^{2×5}，使得 A·x ≈ y
 *  - 用法向方程：A = Yᵀ·X·(Xᵀ·X)⁻¹
 *      X ∈ R^{N×5}  各行为采样特征
 *      Y ∈ R^{N×2}  各行为屏幕像素
 *      返回 A 的行优先一维数组（10 个值）
 *  - 9 点采样 N=9 ≥ 5（不奇异），加微小 ridge 项 λI 提升数值稳定性。
 *
 * 不依赖任何外部线性代数库；矩阵尺寸固定 5×5，手写 Gauss-Jordan 求逆即可。
 */

export const GAZE_FEATURE_DIM = 5;

/** 把 raw gaze 写成特征向量；保持函数纯净便于测试 */
export function gazeFeatureVector(raw: {
  gx: number;
  gy: number;
  yaw: number;
  pitch: number;
}): number[] {
  return [1, raw.gx, raw.gy, raw.yaw, raw.pitch];
}

/** 对 5×5 矩阵 M 求逆（Gauss-Jordan 主元消去），失败返回 null。M 用行优先 25 元数组。 */
function invert5x5(M: number[]): number[] | null {
  const n = 5;
  const a: number[] = new Array(n * n * 2);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      a[i * 2 * n + j] = M[i * n + j];
      a[i * 2 * n + n + j] = i === j ? 1 : 0;
    }
  }
  for (let col = 0; col < n; col++) {
    // 选主元（绝对值最大的行）
    let pivotRow = col;
    let pivotVal = Math.abs(a[col * 2 * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * 2 * n + col]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-12) return null;
    if (pivotRow !== col) {
      for (let k = 0; k < 2 * n; k++) {
        const tmp = a[col * 2 * n + k];
        a[col * 2 * n + k] = a[pivotRow * 2 * n + k];
        a[pivotRow * 2 * n + k] = tmp;
      }
    }
    const pv = a[col * 2 * n + col];
    for (let k = 0; k < 2 * n; k++) a[col * 2 * n + k] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r * 2 * n + col];
      if (factor === 0) continue;
      for (let k = 0; k < 2 * n; k++) {
        a[r * 2 * n + k] -= factor * a[col * 2 * n + k];
      }
    }
  }
  const inv: number[] = new Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      inv[i * n + j] = a[i * 2 * n + n + j];
    }
  }
  return inv;
}

/**
 * 用最小二乘 (X^T X + λI)^-1 X^T Y 求 A^T，再转置得 A。
 * @param features 每行 5 维（gazeFeatureVector 的输出）
 * @param targets  每行 2 维（屏幕像素）
 * @param ridge    L2 正则系数；防止 X^T X 数值奇异，默认 1e-4
 * @returns        A 的行优先 2×5 = 10 元数组；样本不足或奇异返回 null
 */
export function solveAffineLeastSquares(
  features: number[][],
  targets: Array<{ x: number; y: number }>,
  ridge = 1e-4,
): number[] | null {
  if (features.length !== targets.length || features.length < GAZE_FEATURE_DIM) return null;
  const n = features.length;
  const d = GAZE_FEATURE_DIM;
  // XtX (5×5) + ridge·I
  const xtx: number[] = new Array(d * d).fill(0);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += features[k][i] * features[k][j];
      xtx[i * d + j] = s + (i === j ? ridge : 0);
    }
  }
  const inv = invert5x5(xtx);
  if (!inv) return null;
  // XtY (5×2)
  const xtyX: number[] = new Array(d).fill(0);
  const xtyY: number[] = new Array(d).fill(0);
  for (let i = 0; i < d; i++) {
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < n; k++) {
      sx += features[k][i] * targets[k].x;
      sy += features[k][i] * targets[k].y;
    }
    xtyX[i] = sx;
    xtyY[i] = sy;
  }
  // A^T = inv · XtY，最终 A 行优先 [aX_0..aX_4, aY_0..aY_4]
  const A: number[] = new Array(d * 2);
  for (let i = 0; i < d; i++) {
    let ax = 0;
    let ay = 0;
    for (let k = 0; k < d; k++) {
      ax += inv[i * d + k] * xtyX[k];
      ay += inv[i * d + k] * xtyY[k];
    }
    A[i] = ax;
    A[d + i] = ay;
  }
  return A;
}

/** 应用 2×5 仿射矩阵把特征向量映射到屏幕像素 */
export function applyGazeAffine(A: number[], feat: number[]): { x: number; y: number } {
  const d = GAZE_FEATURE_DIM;
  let x = 0;
  let y = 0;
  for (let i = 0; i < d; i++) {
    x += A[i] * feat[i];
    y += A[d + i] * feat[i];
  }
  return { x, y };
}
