import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 웹은 web/ 에서 빌드해 dist/ 로. 개발 중에는 /api 를 로컬 서버(기본 4317)로 넘긴다.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${process.env.PLENUM_PORT || 4317}` },
  },
  test: { root: '.', include: ['test/**/*.test.ts'], testTimeout: 60000, hookTimeout: 60000 },
} as any);
