import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { useChatStore } from './store/chatStore';

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('从 localStorage 恢复会话后显示「新对话」', async () => {
    const now = Date.now();
    localStorage.setItem(
      'chat-storage',
      JSON.stringify({
        state: {
          sessions: [
            {
              id: '1',
              title: '新对话',
              createdAt: now,
              updatedAt: now,
              messages: [],
            },
          ],
          currentSessionId: '1',
        },
        version: 0,
      })
    );
    localStorage.setItem('myagent-onboarding-dismissed', '1');

    await useChatStore.persist.rehydrate();

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '新对话', level: 3 })).toBeInTheDocument();
    });
  });
});
