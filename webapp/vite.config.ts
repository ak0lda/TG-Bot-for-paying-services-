import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Приложение раздаётся бэкендом по /app/. В dev-режиме /api проксируется на локальный бэкенд.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
