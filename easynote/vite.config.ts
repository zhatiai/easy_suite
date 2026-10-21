import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as {
  easynote: string;
};

function mathjaxCleanPlugin() {
  return {
    name: 'mathjax-clean',
    resolveId(id: string) {
      if (id.includes('components/version.js') || id.endsWith('components/version')) {
        return '\0virtual:mathjax-version';
      }
      return null;
    },
    load(id: string) {
      if (id === '\0virtual:mathjax-version') {
        return 'export const VERSION = "3.2.2";\nexport default { VERSION: "3.2.2" };\n';
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    mathjaxCleanPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'EasyNote',
        short_name: 'EasyNote',
        description: '自托管 Markdown 图片笔记',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f9f9f9',
        theme_color: '#f9f9f9',
        categories: ['productivity'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Explicit injection disables the plugin's autoUpdate defaults; preserve immediate takeover.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: [
          '**/*.{html,css,svg,woff2,woff}',
          'registerSW.js',
          'manifest.webmanifest',
          'assets/index-*.js',
          'assets/editor-*.js',
          'assets/markdown-*.js',
          'assets/katex-*.js',
        ],
        runtimeCaching: [{
          urlPattern: /\/(?:assets\/(?:pdfmake|pdfjs|mathjax|pdf\.worker)[^/]*\.(?:js|mjs)|fonts\/NotoSansSC-(?:Regular|Bold)\.otf)$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'easynote-pdf-v1',
            cacheableResponse: { statuses: [0, 200] },
          },
        }],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/\.well-known\//, /^\/mcp/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __EASYNOTE_VERSION__: JSON.stringify(versions.easynote),
    PACKAGE_VERSION: JSON.stringify('3.2.2'),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const rewriteOrigin = (outgoing: { setHeader(name: string, value: string): void }, incoming: { headers: { origin?: string; host?: string } }) => {
            if (incoming.headers.origin === `http://${incoming.headers.host}`) {
              outgoing.setHeader('Origin', 'http://127.0.0.1:8791');
            }
          };
          proxy.on('proxyReq', rewriteOrigin);
          proxy.on('proxyReqWs', rewriteOrigin);
        },
      },
    },
  },
  build: {
    outDir: 'dist/client',
    // MathJax and Mermaid layout engines are lazy-loaded chunks (~1.5-1.9 MB uncompressed).
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/@codemirror/') || id.includes('/@lezer/')) return 'editor';
          if (id.includes('/markdown-it/') || id.includes('/dompurify/')) return 'markdown';
          if (id.includes('/katex/')) return 'katex';
          if (id.includes('/mathjax-full/')) return 'mathjax';
          if (id.includes('/pdfjs-dist/')) return 'pdfjs';
          if (id.includes('/pdfmake/') || id.includes('/html-to-pdfmake/')) return 'pdfmake';
        },
      },
    },
  },
});
