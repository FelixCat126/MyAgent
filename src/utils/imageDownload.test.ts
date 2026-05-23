import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '@/types';
import {
  DownloadLocalFileError,
  downloadDisplayImage,
  hasDesktopLocalSaveCapability,
  sanitizeImageDownloadFileName,
} from './imageDownload';

describe('sanitizeImageDownloadFileName（附件/图片另存文件名）', () => {
  it('保留 Word 等已知扩展名，避免被改成 .png', () => {
    expect(sanitizeImageDownloadFileName('报告.docx', 'image/png')).toBe('报告.docx');
    expect(sanitizeImageDownloadFileName('data.xlsx')).toBe('data.xlsx');
    expect(sanitizeImageDownloadFileName('note.md')).toBe('note.md');
  });

  it('保留常见栅格图片扩展名', () => {
    expect(sanitizeImageDownloadFileName('a.JPEG', '')).toBe('a.JPEG');
    expect(sanitizeImageDownloadFileName('b.webp')).toBe('b.webp');
  });

  it('未知扩展名时按 MIME 补后缀', () => {
    expect(sanitizeImageDownloadFileName('导出文件', 'image/jpeg')).toMatch(/导出文件\.jpg$/);
    expect(sanitizeImageDownloadFileName('导出文件', 'image/gif')).toBe('导出文件.gif');
    expect(sanitizeImageDownloadFileName('导出文件', '')).toBe('导出文件.png');
  });

  it('移除非法字符；超长时在保留扩展名前提下截断', () => {
    expect(sanitizeImageDownloadFileName('ab:c/d<e>.png')).toContain('.png');
    expect(sanitizeImageDownloadFileName('ab:c/d<e>.png')).not.toMatch(/[:<>]/);
    const longKeepExt = `${'x'.repeat(170)}.docx`;
    const out = sanitizeImageDownloadFileName(longKeepExt);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith('.docx')).toBe(true);
  });
});

describe('DownloadLocalFileError', () => {
  it('可区分 source_missing 与 path_empty', () => {
    const a = new DownloadLocalFileError('source_missing');
    expect(a.code).toBe('source_missing');
    const b = new DownloadLocalFileError('path_empty');
    expect(b.code).toBe('path_empty');
  });
});

describe('hasDesktopLocalSaveCapability（桌面壳 vs 浏览器/PWA）', () => {
  it('preload 注入 saveLocalFileCopy 时为 true', () => {
    expect(typeof window.electron?.saveLocalFileCopy).toBe('function');
    expect(hasDesktopLocalSaveCapability()).toBe(true);
  });

  it('saveLocalFileCopy 缺失时为 false（远端壳等）', () => {
    const w = window as Window & { electron?: ElectronAPI };
    const prev = w.electron;
    w.electron = {
      ...prev!,
      saveLocalFileCopy: undefined as unknown as ElectronAPI['saveLocalFileCopy'],
    };
    expect(hasDesktopLocalSaveCapability()).toBe(false);
    w.electron = prev;
  });
});

describe('downloadDisplayImage（会话缩略图/预览下载链路）', () => {
  let origSave: ElectronAPI['saveLocalFileCopy'];
  /** 覆盖 jsdom/Node 自带的 fetch，保证走 mock */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origSave = window.electron!.saveLocalFileCopy;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    window.electron!.saveLocalFileCopy = origSave;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('有本地路径且主进程拷贝成功时不发起 fetch', async () => {
    const save = vi.fn(async () => ({ ok: true as const, path: '/dst/a.png' }));
    window.electron!.saveLocalFileCopy = save;
    await downloadDisplayImage({
      src: 'local-file:///app/x.png',
      sourceLocalPath: '/app/x.png',
      defaultFileName: 'x.png',
    });
    expect(save).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('用户取消另存为时不 fallback fetch、不抛错', async () => {
    window.electron!.saveLocalFileCopy = vi.fn(async () => ({
      ok: false as const,
      canceled: true as const,
    }));
    await downloadDisplayImage({
      src: 'local-file:///nope',
      sourceLocalPath: '/tmp/a.png',
      defaultFileName: 'a.png',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('源文件不存在时立即抛 DownloadLocalFileError，不 fallback', async () => {
    window.electron!.saveLocalFileCopy = vi.fn(async () => ({
      ok: false as const,
      error: '源文件不存在' as const,
    }));
    await expect(
      downloadDisplayImage({
        src: 'local-file:///gone',
        sourceLocalPath: '/no/such/file.png',
        defaultFileName: 'f.png',
      })
    ).rejects.toThrow(DownloadLocalFileError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('无本地路径可走 fetch(blob) 成功并结束', async () => {
    window.electron!.saveLocalFileCopy = vi.fn(async () => ({ ok: false as const }));
    const body = new Blob(['\x89PNG'], { type: 'image/png' });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadDisplayImage({
      src: 'https://example.test/x.png',
      defaultFileName: 'remote.png',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('electron 不可用且 fetch 失败时抛错', async () => {
    const w = window as Window & { electron?: ElectronAPI };
    const prev = w.electron;
    w.electron = {
      ...prev!,
      saveLocalFileCopy: undefined as unknown as ElectronAPI['saveLocalFileCopy'],
    };
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      downloadDisplayImage({ src: 'https://example.test/missing', defaultFileName: 'x.png' })
    ).rejects.toThrow('unable to save image');

    w.electron = prev;
  });
});
