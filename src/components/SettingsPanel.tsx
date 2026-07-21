import React, { useEffect } from 'react';
import { useSettingStore } from '../store/settingStore';
import { WebSearchSection } from './settings/WebSearchSection';
import { KnowledgeSection } from './settings/KnowledgeSection';
import { AppSection } from './settings/AppSection';
import { ModelsSection } from './settings/ModelsSection';
import { useI18n } from '../hooks/useI18n';
import { useSystemTtsAvailable } from '@/hooks/useSystemTtsAvailable';
import { useMediaInputAvailability } from '@/hooks/useMediaInputAvailability';

/**
 * 设置面板：仅负责跨域共享的硬件可用性检测 + 媒体守卫 useEffect，
 * 然后把 `cardShell` / `t` / `locale` / 媒体信息分发给 4 个自管理状态的子组件。
 *
 * 状态拆分原则：
 *  - 折叠态、表单、索引、网关等局部 useState 已全部下放到对应子组件
 *  - 本组件只持有：t / locale、systemTtsAvailable、cameraMissing / microphoneMissing、cardShell
 *  - 媒体守卫 useEffect（硬件缺失时强制关闭对应开关）保留在本组件，因为它跨多个 store 字段，
 *    且依赖父组件挂载的探测 hook 结果
 */
const SettingsPanel: React.FC = () => {
  const { t, locale } = useI18n();
  const systemTtsAvailable = useSystemTtsAvailable(locale);
  const {
    speechInputEnabled,
    setSpeechInputEnabled,
    voiceWakeEnabled,
    setVoiceWakeEnabled,
    voiceReplyEnabled,
    setVoiceReplyEnabled,
    gestureControlEnabled,
    setGestureControlEnabled,
  } = useSettingStore();

  /**
   * 硬件可用性检测：物理缺失则强制关闭对应开关，避免在无硬件环境下被意外激活。
   * - 摄像头缺失 → 手势/视觉识别关闭并禁用
   * - 麦克风缺失 → 语音输入 / 唤醒 / 播报三者全部关闭并禁用
   */
  const mediaAvail = useMediaInputAvailability();
  const cameraMissing = mediaAvail.camera === 'missing';
  const microphoneMissing = mediaAvail.microphone === 'missing';

  useEffect(() => {
    if (systemTtsAvailable === false && voiceReplyEnabled) {
      setVoiceReplyEnabled(false);
    }
  }, [systemTtsAvailable, voiceReplyEnabled, setVoiceReplyEnabled]);

  useEffect(() => {
    if (cameraMissing && gestureControlEnabled) setGestureControlEnabled(false);
  }, [cameraMissing, gestureControlEnabled, setGestureControlEnabled]);

  useEffect(() => {
    if (!microphoneMissing) return;
    if (speechInputEnabled) setSpeechInputEnabled(false);
    if (voiceWakeEnabled) setVoiceWakeEnabled(false);
    if (voiceReplyEnabled) setVoiceReplyEnabled(false);
  }, [
    microphoneMissing,
    speechInputEnabled,
    setSpeechInputEnabled,
    voiceWakeEnabled,
    setVoiceWakeEnabled,
    voiceReplyEnabled,
    setVoiceReplyEnabled,
  ]);

  const cardShell =
    'mx-3 rounded-xl border border-stone-300/45 bg-white/88 shadow-sm dark:border-white/10 dark:bg-slate-900/55 dark:shadow-none';

  return (
    <div className="flex h-full flex-col bg-stone-100/95 backdrop-blur-xl dark:bg-darkChrome/80">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2.5 scrollbar-hide" data-gesture-scroll-target="settings">
        {/* 模型配置：独立卡片 */}
        <ModelsSection cardShell={cardShell} t={t} />

        <WebSearchSection cardShell={cardShell} t={t} />

        <KnowledgeSection cardShell={cardShell} t={t} />

        <AppSection
          systemTtsAvailable={systemTtsAvailable}
          microphoneMissing={microphoneMissing}
          cameraMissing={cameraMissing}
          locale={locale}
          cardShell={cardShell}
          t={t}
        />
      </div>
    </div>
  );
};

export default SettingsPanel;
