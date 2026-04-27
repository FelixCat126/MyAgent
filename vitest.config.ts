import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** 单元测试独立配置，避免加载 Electron 相关 Vite 插件 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
