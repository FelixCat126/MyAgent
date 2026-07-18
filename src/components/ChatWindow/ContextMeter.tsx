import React from 'react';

export interface ContextMeterProps {
  stored: number;
  overhead: number;
  softLimit: number;
  fullAt: number;
  truncateRisk: boolean;
  contextUsageHintTemplate: string;
  contextSanitizeWarn: string;
}

/**
 * 上下文使用量进度条。
 * 当总长度为 0 时返回 null；否则渲染一条位于顶部的细进度条，
 * 接近上限或存在截断风险时变为橙色，并展示对应提示。
 */
export const ContextMeter: React.FC<ContextMeterProps> = ({
  stored,
  overhead,
  softLimit,
  fullAt,
  truncateRisk,
  contextUsageHintTemplate,
  contextSanitizeWarn,
}) => {
  const totalLength = stored + overhead;
  if (totalLength <= 0) return null;

  const fillPerc = Math.min((totalLength / Math.max(1, fullAt)) * 100, 100);
  const isNearLimit = fillPerc > 80;
  const softPct = Math.round(Math.min((totalLength / Math.max(1, softLimit)) * 100, 100));
  const baseHint = contextUsageHintTemplate
    .replace('{used}', String(Math.round(totalLength / 1000)))
    .replace('{limit}', String(Math.round(softLimit / 1000)))
    .replace('{pct}', String(softPct));
  const title = truncateRisk ? `${baseHint} · ${contextSanitizeWarn}` : baseHint;

  return (
    <div
      className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
        isNearLimit || truncateRisk ? 'bg-orange-500' : 'bg-gradient-to-r from-primary-400 to-teal-500'
      }`}
      style={{ width: `${fillPerc}%` }}
      title={title}
    />
  );
};
