import { describe, expect, it } from 'vitest';
import { markdownContainsPipeTable } from './markdownTableDetect';

describe('markdownContainsPipeTable', () => {
  it('false for plain text', () => {
    expect(markdownContainsPipeTable('你好，这是普通回答。')).toBe(false);
  });

  it('true for GFM table', () => {
    expect(
      markdownContainsPipeTable(`| a | b |
| --- | --- |
| 1 | 2 |`)
    ).toBe(true);
  });
});
