import { describe, expect, it } from 'vitest';
import { detectWakePhrase, detectWakePhraseLoose, normalizeWakeText } from './useVoiceWake';

describe('useVoiceWake helpers', () => {
  it('normalizeWakeText 去空白与标点', () => {
    expect(normalizeWakeText('  小，助手！  ')).toBe('小助手');
    expect(normalizeWakeText('Hey Agent.')).toBe('heyagent');
  });

  it('detectWakePhrase 精确命中', () => {
    expect(detectWakePhrase('小媛小媛帮我写邮件', '小媛小媛')).toBe(true);
    expect(detectWakePhrase('今天天气不错', '小媛小媛')).toBe(false);
  });

  it('detectWakePhraseLoose 同音字唤醒', () => {
    expect(detectWakePhraseLoose('小源小园在吗', '小媛小媛')).toBe(true);
    expect(detectWakePhraseLoose('小元，小猿', '小媛小媛')).toBe(true);
    expect(detectWakePhraseLoose('嗯小园小园', '小媛小媛')).toBe(true);
    expect(detectWakePhraseLoose('今天天气不错', '小媛小媛')).toBe(false);
  });

  it('detectWakePhrase 自定义唤醒词', () => {
    expect(detectWakePhrase('你好助手帮我写', '你好助手')).toBe(true);
    expect(detectWakePhrase('助手你好', '你好助手')).toBe(false);
    expect(detectWakePhraseLoose('你好助手在吗', '你好助手')).toBe(true);
  });
});
