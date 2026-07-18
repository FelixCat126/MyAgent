// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';

/** 主进程 import 链：electron + ./media-library + ./file + ./persist。测试只关心纯函数。 */
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/myagent-test' },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
}));

vi.mock('./media-library', () => ({
  deleteMediaLibraryImageByAbsolutePath: vi.fn(),
  listMediaLibraryImageItems: vi.fn(),
}));

vi.mock('./file', () => ({
  getUploadDir: () => '/tmp/myagent-test/uploads',
  writeUploadBufferToUserData: vi.fn(),
}));

vi.mock('./persist', () => ({
  readPersistParsedSync: () => null,
}));

import {
  authorize,
  mergeRemoteGatewayPatch,
  mimeForPath,
  normalizeRemoteRequestPathname,
  parseMultipartFiles,
  pickRemoteStandaloneAsset,
  publicRemoteGatewayGet,
  type RemoteGatewayFileConfig,
} from './remote-gateway';

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('mergeRemoteGatewayPatch（配置合并）', () => {
  const base: RemoteGatewayFileConfig = { enabled: false, port: 9742, token: 'old-token' };

  it('修改 enabled / port', () => {
    const r = mergeRemoteGatewayPatch(base, { enabled: true, port: 11000 });
    expect(r).toEqual({ enabled: true, port: 11000, token: 'old-token' });
  });

  it('port 越界抛错', () => {
    expect(() => mergeRemoteGatewayPatch(base, { port: 80 })).toThrow(/invalid port/i);
    expect(() => mergeRemoteGatewayPatch(base, { port: 99999 })).toThrow(/invalid port/i);
  });

  it('regenerateToken 优先于显式 token', () => {
    const r = mergeRemoteGatewayPatch(base, { regenerateToken: true, token: 'ignored' });
    expect(r.token).not.toBe('old-token');
    expect(r.token).not.toBe('ignored');
    expect(r.token.length).toBeGreaterThan(0);
  });

  it('显式 token 不能为空', () => {
    expect(() => mergeRemoteGatewayPatch(base, { token: '   ' })).toThrow(/token empty/);
  });

  it('显式 token 接受 trim 后写入', () => {
    const r = mergeRemoteGatewayPatch(base, { token: '  new-token  ' });
    expect(r.token).toBe('new-token');
  });
});

describe('normalizeRemoteRequestPathname（反代/子路径归一化）', () => {
  it('原样保留 /remote/api/* 与 /', () => {
    expect(normalizeRemoteRequestPathname('/')).toBe('/');
    expect(normalizeRemoteRequestPathname('/remote/api/state')).toBe('/remote/api/state');
  });

  it('反代去掉 /remote 前缀的 /api/... 归位', () => {
    expect(normalizeRemoteRequestPathname('/api/state')).toBe('/remote/api/state');
    expect(normalizeRemoteRequestPathname('/api/session/active')).toBe('/remote/api/session/active');
  });

  it('带反代前缀的 /xxx/remote/api/... 抽取尾段', () => {
    expect(normalizeRemoteRequestPathname('/proxy/remote/api/chat')).toBe('/remote/api/chat');
  });

  it('去除多余 / 与尾部 /', () => {
    expect(normalizeRemoteRequestPathname('//remote//api//meta/')).toBe('/remote/api/meta');
  });
});

describe('mimeForPath / pickRemoteStandaloneAsset / publicRemoteGatewayGet', () => {
  it('mime 映射常见扩展名', () => {
    expect(mimeForPath('a.png')).toBe('image/png');
    expect(mimeForPath('x.WEBMANIFEST')).toBe('application/manifest+json');
    expect(mimeForPath('y.docx')).toMatch(/wordprocessingml/);
    expect(mimeForPath('z.unknown')).toBe('application/octet-stream');
  });

  it('PWA standalone 资产识别', () => {
    expect(pickRemoteStandaloneAsset('/remote/manifest.webmanifest')).toBe('manifest');
    expect(pickRemoteStandaloneAsset('/x/remote/apple-touch-icon.png')).toBe('touchIcon');
    expect(pickRemoteStandaloneAsset('/remote/api/state')).toBeNull();
  });

  it('publicRemoteGatewayGet：仅 GET 且为根/壳静态资源', () => {
    expect(publicRemoteGatewayGet('GET', '/')).toBe(true);
    expect(publicRemoteGatewayGet('GET', '/remote')).toBe(true);
    expect(publicRemoteGatewayGet('GET', '/remote/manifest.webmanifest')).toBe(true);
    expect(publicRemoteGatewayGet('POST', '/')).toBe(false);
    expect(publicRemoteGatewayGet('GET', '/remote/api/state')).toBe(false);
  });
});

describe('authorize（鉴权）', () => {
  it('Authorization: Bearer <token> 通过', () => {
    const ok = authorize(
      fakeReq({ authorization: 'Bearer abc123' }),
      new URL('http://x/remote/api/state'),
      'abc123'
    );
    expect(ok).toBe(true);
  });

  it('?t=<token> 不再被接受（已移除 query token 鉴权）', () => {
    const ok = authorize(
      fakeReq({}),
      new URL('http://x/remote/api/state?t=tk'),
      'tk'
    );
    expect(ok).toBe(false);
  });

  it('token 不匹配返回 false', () => {
    expect(
      authorize(
        fakeReq({ authorization: 'Bearer wrong' }),
        new URL('http://x/remote/api/state'),
        'abc123'
      )
    ).toBe(false);
  });
});

describe('parseMultipartFiles', () => {
  function multipart(files: Array<{ name: string; type: string; data: Buffer }>): {
    body: Buffer;
    contentType: string;
  } {
    const boundary = '----myagentTest';
    const eol = '\r\n';
    const segments: Buffer[] = [];
    for (const f of files) {
      const head =
        `--${boundary}${eol}` +
        `Content-Disposition: form-data; name="f"; filename="${f.name}"${eol}` +
        `Content-Type: ${f.type}${eol}${eol}`;
      segments.push(Buffer.from(head, 'utf8'), f.data);
      segments.push(Buffer.from(eol, 'utf8'));
    }
    segments.push(Buffer.from(`--${boundary}--${eol}`, 'utf8'));
    /** 服务端解析期望首段以 --boundary\r\n 起始 */
    return {
      body: Buffer.concat(segments),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it('解析单文件，保留二进制完整长度', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xee]);
    const m = multipart([{ name: 'x.png', type: 'image/png', data }]);
    const files = await parseMultipartFiles(m.body, m.contentType);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('x.png');
    expect(files[0].type).toBe('image/png');
    expect(files[0].size).toBe(data.length);
    expect(files[0].buffer.equals(data)).toBe(true);
  });

  it('多文件按序返回', async () => {
    const m = multipart([
      { name: 'a.txt', type: 'text/plain', data: Buffer.from('hi') },
      { name: 'b.bin', type: 'application/octet-stream', data: Buffer.from([1, 2, 3]) },
    ]);
    const files = await parseMultipartFiles(m.body, m.contentType);
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.bin']);
  });

  it('contentType 缺失或非 multipart 时抛错', () => {
    expect(() => parseMultipartFiles(Buffer.from(''), 'application/json')).toThrow(
      /Expected multipart/
    );
  });

  it('boundary 缺失时抛错', () => {
    expect(() => parseMultipartFiles(Buffer.from(''), 'multipart/form-data')).toThrow(
      /boundary/
    );
  });
});
