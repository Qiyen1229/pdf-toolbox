import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false, // 使用 public/manifest.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        globIgnores: ['vendor/tesseract/core/**', 'vendor/tessdata/**'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          // OCR 引擎與語言資料：第一次使用時下載，之後離線可用
          { urlPattern: ({ url }) => url.pathname.startsWith('/vendor/'), handler: 'CacheFirst',
            options: { cacheName: 'ocr-vendor', expiration: { maxEntries: 30 } } },
        ],
      },
    }),
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': 'http://localhost:9133' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 60000 },
});
