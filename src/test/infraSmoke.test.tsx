/** 最简渲染冒烟：验证 jsdom + testing-library + useI18n hook 链路能工作。 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { useI18n } from '../hooks/useI18n';

function Probe() {
  const { t } = useI18n();
  return <span data-testid="t">{t('app.newChat')}</span>;
}

describe('test infra smoke', () => {
  it('useI18n hook returns a working translator', () => {
    render(<Probe />);
    expect(screen.getByTestId('t').textContent).toBeTruthy();
  });
});
