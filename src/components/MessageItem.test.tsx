/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ElectronAPI } from '@/types';
import {
  ConversationImageGalleryModal,
  ImagePreviewModal,
} from './MessageItem';
import { useSettingStore } from '../store/settingStore';

const ORIGINAL_SAVE = window.electron!.saveLocalFileCopy;

function setSaveCapability(present: boolean): void {
  const w = window as Window & { electron?: ElectronAPI };
  if (present) {
    w.electron = { ...w.electron!, saveLocalFileCopy: ORIGINAL_SAVE };
    return;
  }
  w.electron = {
    ...w.electron!,
    saveLocalFileCopy: undefined as unknown as ElectronAPI['saveLocalFileCopy'],
  };
}

beforeEach(() => {
  useSettingStore.setState({ locale: 'zh' });
});

afterEach(() => {
  cleanup();
  setSaveCapability(true);
});

describe('ImagePreviewModal（桌面/移动壳分流）', () => {
  it('桌面壳：显示「下载」按钮，不显示长按保存提示', () => {
    setSaveCapability(true);
    render(
      <ImagePreviewModal
        src="local-file:///app/x.png"
        onClose={() => {}}
        alt="img"
        localPath="/app/x.png"
        defaultFileName="x.png"
      />
    );
    expect(screen.queryAllByRole('button', { name: '下载' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/长按大图可通过系统菜单保存到相册/)).toBeNull();
  });

  it('远端/移动壳：不显示「下载」按钮，给出长按保存提示', () => {
    setSaveCapability(false);
    render(
      <ImagePreviewModal
        src="local-file:///app/x.png"
        onClose={() => {}}
        alt="img"
        localPath="/app/x.png"
        defaultFileName="x.png"
      />
    );
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
    expect(screen.getByText(/长按大图可通过系统菜单保存到相册/)).toBeInTheDocument();
  });
});

describe('ConversationImageGalleryModal（会话图库分流）', () => {
  const slides = [
    {
      messageId: 'm1',
      fileIndex: 0,
      src: 'local-file:///a.png',
      localPath: '/a.png',
      defaultFileName: 'a.png',
    },
    {
      messageId: 'm1',
      fileIndex: 1,
      src: 'local-file:///b.png',
      localPath: '/b.png',
      defaultFileName: 'b.png',
    },
  ];

  it('桌面壳：显示「下载」按钮、不显示长按提示，且展示分页文案', () => {
    setSaveCapability(true);
    render(
      <ConversationImageGalleryModal slides={slides} startIndex={0} onClose={() => {}} />
    );
    expect(screen.queryByRole('button', { name: '下载' })).toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 张')).toBeInTheDocument();
    expect(screen.queryByText(/长按大图可通过系统菜单/)).toBeNull();
  });

  it('远端/移动壳：不显示「下载」按钮，且展示长按提示', () => {
    setSaveCapability(false);
    render(
      <ConversationImageGalleryModal slides={slides} startIndex={0} onClose={() => {}} />
    );
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
    expect(screen.getByText(/长按大图可通过系统菜单保存到相册/)).toBeInTheDocument();
  });

  it('英文 locale：下载按钮与长按提示走英文', () => {
    setSaveCapability(true);
    useSettingStore.setState({ locale: 'en' });
    render(
      <ConversationImageGalleryModal slides={slides} startIndex={0} onClose={() => {}} />
    );
    expect(screen.queryByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});
