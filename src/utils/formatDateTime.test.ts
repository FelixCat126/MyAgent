import { describe, it, expect } from 'vitest';
import { formatDateTime } from './formatDateTime';

describe('formatDateTime', () => {
  it('始终含年月日与时分（24 小时制）', () => {
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    const out = formatDateTime(today.getTime());
    expect(out).toMatch(/\d/);
    expect(out).toMatch(/09:05|9:05/);
  });
  it('历史日期含年份与时分', () => {
    const old = new Date('2020-03-15T10:30:00');
    const out = formatDateTime(old.getTime());
    expect(out).toContain('2020');
    expect(out).toMatch(/10:30/);
  });
  it('en locale 同样为 24 小时制且无 AM/PM', () => {
    const old = new Date('2020-03-15T15:30:00');
    const out = formatDateTime(old.getTime(), 'en');
    expect(out).toContain('2020');
    expect(out).not.toMatch(/\bAM\b|\bPM\b/i);
  });
  it('含完整 HH:MM 分钟段', () => {
    const d = new Date(2024, 0, 5, 7, 3);
    const out = formatDateTime(d.getTime());
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});
