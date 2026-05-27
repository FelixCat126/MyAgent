import React, { useEffect, useRef, useState } from 'react';
import { useParticleStore } from '../store/particleStore';
import { useGazeCalibrationStore } from '../store/gazeCalibrationStore';
import { gazeFeatureVector, solveAffineLeastSquares } from '../utils/gazeFit';
import { useI18n } from '../hooks/useI18n';

/**
 * 视线 9 点校准。
 *
 * 流程：intro → sampling[0..8] → fitting → success / fail
 *  - 每个目标点先 600ms 让用户视线对焦（"准备"阶段），再 1400ms 采样（每 60ms 取一帧 gazeRaw）
 *  - 9 点采样均值作为 9 个回归样本，调用 solveAffineLeastSquares 拟合 2×5 仿射矩阵
 *  - 拟合结果写入 gazeCalibrationStore（持久化），GazeIndicator 自动启用映射
 *
 * 触发：受控 props open；onClose 关闭。校准期间用户应保持头部基本不动。
 */
interface GazeCalibrationProps {
  open: boolean;
  onClose: () => void;
}

/** 3×3 网格相对视口比例。边距 10% 留出鼠标 / 标题栏区域 */
const TARGETS_RATIO: Array<{ rx: number; ry: number }> = [
  { rx: 0.1, ry: 0.12 },
  { rx: 0.5, ry: 0.12 },
  { rx: 0.9, ry: 0.12 },
  { rx: 0.1, ry: 0.5 },
  { rx: 0.5, ry: 0.5 },
  { rx: 0.9, ry: 0.5 },
  { rx: 0.1, ry: 0.88 },
  { rx: 0.5, ry: 0.88 },
  { rx: 0.9, ry: 0.88 },
];

const PER_POINT_PREPARE_MS = 600;
const PER_POINT_SAMPLE_MS = 1400;
const SAMPLE_INTERVAL_MS = 60;

type Phase = 'intro' | 'sampling' | 'fitting' | 'success' | 'fail';

const GazeCalibration: React.FC<GazeCalibrationProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('intro');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [progressMs, setProgressMs] = useState(0);
  const samplesRef = useRef<Array<{ features: number[]; target: { x: number; y: number } }>>([]);
  const viewportRef = useRef({ w: 0, h: 0 });
  const setCalibration = useGazeCalibrationStore((s) => s.setCalibration);

  useEffect(() => {
    if (!open) {
      setPhase('intro');
      setCurrentIdx(0);
      setProgressMs(0);
      samplesRef.current = [];
      return;
    }
    viewportRef.current = { w: window.innerWidth, h: window.innerHeight };
  }, [open]);

  const startSampling = () => {
    samplesRef.current = [];
    setPhase('sampling');
    setCurrentIdx(0);
    setProgressMs(0);
  };

  /**
   * 当 phase=sampling 时执行当前 currentIdx 的采样：
   * 先 PREPARE_MS 不采，再 SAMPLE_MS 内每 SAMPLE_INTERVAL_MS 取一帧特征向量。
   */
  useEffect(() => {
    if (phase !== 'sampling') return;
    let cancelled = false;
    const target = TARGETS_RATIO[currentIdx];
    const vp = viewportRef.current;
    const targetPx = { x: target.rx * vp.w, y: target.ry * vp.h };
    const totalMs = PER_POINT_PREPARE_MS + PER_POINT_SAMPLE_MS;
    const startedAt = performance.now();
    const collected: number[][] = [];

    const step = () => {
      if (cancelled) return;
      const elapsed = performance.now() - startedAt;
      setProgressMs(Math.min(totalMs, elapsed));
      if (elapsed >= PER_POINT_PREPARE_MS) {
        const raw = useParticleStore.getState().gazeRaw;
        if (raw) collected.push(gazeFeatureVector(raw));
      }
      if (elapsed < totalMs) {
        window.setTimeout(step, SAMPLE_INTERVAL_MS);
        return;
      }
      if (collected.length > 0) {
        const dim = collected[0].length;
        const avg: number[] = new Array(dim).fill(0);
        for (const c of collected) for (let i = 0; i < dim; i++) avg[i] += c[i];
        for (let i = 0; i < dim; i++) avg[i] /= collected.length;
        samplesRef.current.push({ features: avg, target: targetPx });
      }
      if (cancelled) return;
      if (currentIdx < TARGETS_RATIO.length - 1) {
        setCurrentIdx((i) => i + 1);
        setProgressMs(0);
      } else {
        setPhase('fitting');
      }
    };
    step();

    return () => {
      cancelled = true;
    };
  }, [phase, currentIdx]);

  useEffect(() => {
    if (phase !== 'fitting') return;
    if (samplesRef.current.length < 5) {
      setPhase('fail');
      return;
    }
    const A = solveAffineLeastSquares(
      samplesRef.current.map((s) => s.features),
      samplesRef.current.map((s) => s.target),
    );
    if (!A) {
      setPhase('fail');
      return;
    }
    setCalibration(A, viewportRef.current);
    setPhase('success');
  }, [phase, setCalibration]);

  if (!open) return null;

  const vp = viewportRef.current;
  const target = TARGETS_RATIO[currentIdx];
  const tx = target.rx * vp.w;
  const ty = target.ry * vp.h;
  const inSampling = phase === 'sampling';
  const isSamplingNow = inSampling && progressMs >= PER_POINT_PREPARE_MS;
  const ringProgress = inSampling
    ? Math.min(1, progressMs / (PER_POINT_PREPARE_MS + PER_POINT_SAMPLE_MS))
    : 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(15,15,20,0.92)' }}
      role="dialog"
      aria-modal="true"
    >
      {phase === 'intro' && (
        <div className="max-w-md rounded-2xl bg-white/10 p-6 text-center text-slate-100 backdrop-blur-md">
          <h2 className="mb-2 text-lg font-semibold">{t('gaze.calib.title')}</h2>
          <p className="mb-4 text-sm text-slate-300">{t('gaze.calib.intro')}</p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              className="rounded-lg bg-white/15 px-4 py-2 text-sm hover:bg-white/25"
              onClick={onClose}
            >
              {t('gaze.calib.cancel')}
            </button>
            <button
              type="button"
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm text-white hover:bg-emerald-600"
              onClick={startSampling}
            >
              {t('gaze.calib.start')}
            </button>
          </div>
        </div>
      )}

      {inSampling && (
        <>
          <div
            className="absolute"
            style={{
              left: tx - 24,
              top: ty - 24,
              width: 48,
              height: 48,
            }}
          >
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: isSamplingNow ? '#10b981' : '#fbbf24',
                boxShadow: isSamplingNow
                  ? '0 0 28px rgba(16,185,129,0.75)'
                  : '0 0 20px rgba(251,191,36,0.65)',
                transform: `scale(${0.55 + ringProgress * 0.45})`,
                transition: 'transform 60ms linear, background 200ms ease',
              }}
            />
            <div className="absolute inset-0 rounded-full border-2 border-white/75" />
          </div>
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-xs text-slate-200 backdrop-blur">
            {t('gaze.calib.progress', { n: currentIdx + 1, total: TARGETS_RATIO.length })}
          </div>
        </>
      )}

      {phase === 'fitting' && (
        <div className="text-sm text-slate-300">{t('gaze.calib.fitting')}</div>
      )}

      {phase === 'success' && (
        <div className="max-w-md rounded-2xl bg-white/10 p-6 text-center text-slate-100 backdrop-blur-md">
          <h2 className="mb-2 text-lg font-semibold">{t('gaze.calib.successTitle')}</h2>
          <p className="mb-4 text-sm text-slate-300">{t('gaze.calib.successDesc')}</p>
          <button
            type="button"
            className="rounded-lg bg-white/15 px-4 py-2 text-sm hover:bg-white/25"
            onClick={onClose}
          >
            {t('gaze.calib.done')}
          </button>
        </div>
      )}

      {phase === 'fail' && (
        <div className="max-w-md rounded-2xl bg-white/10 p-6 text-center text-slate-100 backdrop-blur-md">
          <h2 className="mb-2 text-lg font-semibold">{t('gaze.calib.failTitle')}</h2>
          <p className="mb-4 text-sm text-slate-300">{t('gaze.calib.failDesc')}</p>
          <button
            type="button"
            className="rounded-lg bg-white/15 px-4 py-2 text-sm hover:bg-white/25"
            onClick={onClose}
          >
            {t('gaze.calib.close')}
          </button>
        </div>
      )}
    </div>
  );
};

export default GazeCalibration;
