// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ENC_VALUE_PREFIX,
  protectPersistValue,
  revealPersistValue,
  type DecryptString,
  type EncryptString,
} from './secureFields';

/** 可逆的伪加密：仅用于测试往返逻辑（真实实现为 safeStorage） */
const fakeEncrypt: EncryptString = (plain) => Buffer.from(`x${plain}`, 'utf-8').toString('base64');
const fakeDecrypt: DecryptString = (b64) => {
  const s = Buffer.from(b64, 'base64').toString('utf-8');
  if (!s.startsWith('x')) throw new Error('bad cipher');
  return s.slice(1);
};

describe('protectPersistValue', () => {
  it('加密敏感键并加前缀', () => {
    const input = {
      state: {
        models: [
          { id: 'm1', name: 'GPT', apiKey: 'sk-secret', apiUrl: 'https://x' },
          { id: 'm2', name: 'Local', apiKey: '' },
        ],
      },
      version: 2,
    };
    const out = protectPersistValue(input, fakeEncrypt) as typeof input;
    const m1 = out.state.models[0];
    expect(m1.apiKey.startsWith(ENC_VALUE_PREFIX)).toBe(true);
    expect(m1.apiKey).not.toContain('sk-secret');
    expect(m1.apiUrl).toBe('https://x');
    expect(m1.name).toBe('GPT');
    // 空串不加密
    expect(out.state.models[1].apiKey).toBe('');
    expect(out.version).toBe(2);
  });

  it('幂等：已加密值不二次加密', () => {
    const once = protectPersistValue({ apiKey: 'sk-a' }, fakeEncrypt) as { apiKey: string };
    const twice = protectPersistValue(once, fakeEncrypt) as { apiKey: string };
    expect(twice.apiKey).toBe(once.apiKey);
  });

  it('encrypt 为 null（无钥匙串）时整体直通', () => {
    const input = { apiKey: 'sk-plain', nested: { token: 'abc' } };
    expect(protectPersistValue(input, null)).toEqual(input);
  });

  it('加密 env 字典的全部字符串值', () => {
    const input = {
      imageGeneratorConfig: {
        endpoint: 'https://x',
        env: { ARK_API_KEY: 'ark-secret', PLAIN: 'v', NUM: 3 },
      },
    };
    const out = protectPersistValue(input, fakeEncrypt) as typeof input;
    const env = out.imageGeneratorConfig.env as Record<string, unknown>;
    expect(String(env.ARK_API_KEY).startsWith(ENC_VALUE_PREFIX)).toBe(true);
    expect(String(env.PLAIN).startsWith(ENC_VALUE_PREFIX)).toBe(true);
    expect(env.NUM).toBe(3);
    expect(out.imageGeneratorConfig.endpoint).toBe('https://x');
  });

  it('覆盖全部敏感键名（embeddingApiKey / volcAsr* / token）', () => {
    const input = {
      embeddingApiKey: 'e1',
      volcAsrAppKey: 'e2',
      volcAsrAccessKey: 'e3',
      token: 'e4',
      maxTokens: 4096,
    };
    const out = protectPersistValue(input, fakeEncrypt) as Record<string, unknown>;
    for (const k of ['embeddingApiKey', 'volcAsrAppKey', 'volcAsrAccessKey', 'token']) {
      expect(String(out[k]).startsWith(ENC_VALUE_PREFIX)).toBe(true);
    }
    expect(out.maxTokens).toBe(4096);
  });
});

describe('revealPersistValue', () => {
  it('加密→还原 往返一致', () => {
    const input = {
      state: {
        models: [{ apiKey: 'sk-live', imageGeneratorConfig: { apiKey: 'img-key', env: { A: 'b' } } }],
        embeddingApiKey: 'emb',
      },
    };
    const protectedOnce = protectPersistValue(input, fakeEncrypt);
    const revealed = revealPersistValue(protectedOnce, fakeDecrypt);
    expect(revealed).toEqual(input);
  });

  it('旧明文（无前缀）原样直通', () => {
    const legacy = { apiKey: 'sk-old-plain', token: 'tok' };
    expect(revealPersistValue(legacy, fakeDecrypt)).toEqual(legacy);
  });

  it('解密失败时原样保留密文（无损往返）', () => {
    const badDecrypt: DecryptString = () => {
      throw new Error('keychain denied');
    };
    const protectedOnce = protectPersistValue({ apiKey: 'sk-x' }, fakeEncrypt) as { apiKey: string };
    const revealed = revealPersistValue(protectedOnce, badDecrypt) as { apiKey: string };
    expect(revealed.apiKey).toBe(protectedOnce.apiKey);
  });

  it('decrypt 为 null 时密文原样保留', () => {
    const protectedOnce = protectPersistValue({ apiKey: 'sk-x' }, fakeEncrypt);
    expect(revealPersistValue(protectedOnce, null)).toEqual(protectedOnce);
  });

  it('聊天记录形状（无敏感键）结构不变', () => {
    const chat = {
      state: {
        sessions: [
          { id: 's1', title: '对话', messages: [{ role: 'user', content: 'apiKey 三个字出现在正文里' }] },
        ],
      },
    };
    const protectedOnce = protectPersistValue(chat, fakeEncrypt);
    expect(protectedOnce).toEqual(chat);
    expect(revealPersistValue(protectedOnce, fakeDecrypt)).toEqual(chat);
  });

  it('数组根与标量根不报错', () => {
    expect(revealPersistValue([1, 'a', null], fakeDecrypt)).toEqual([1, 'a', null]);
    expect(revealPersistValue('plain', fakeDecrypt)).toBe('plain');
    expect(revealPersistValue(null, fakeDecrypt)).toBe(null);
  });
});
