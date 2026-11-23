import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let easynoteVersion = '0.7.8';
try {
  const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as {
    easynote: string;
  };
  easynoteVersion = versions.easynote;
} catch {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    easynoteVersion = pkg.version;
  } catch {
    /* fallback to default */
  }
}

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
    {
      name: 'excalidraw-fonts',
      apply: 'build',
      generateBundle() {
        const root = 'node_modules/@excalidraw/excalidraw/dist/prod';
        for (const file of readdirSync(join(root, 'fonts'), { recursive: true, encoding: 'utf8' })) {
          if (!file.endsWith('.woff2')) continue;
          this.emitFile({ type: 'asset', fileName: `whiteboard-assets/fonts/${file}`, source: readFileSync(join(root, 'fonts', file)) });
        }
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['easynote-knowledge-apple.png'],
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
          { src: '/easynote-knowledge-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/easynote-knowledge-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/easynote-knowledge-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Explicit injection disables the plugin's autoUpdate defaults; preserve immediate takeover.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: [
          '**/*.{html,svg,woff2,woff}',
          'assets/{index,katex}-*.css',
          'registerSW.js',
          'manifest.webmanifest',
          'assets/index-*.js',
          'assets/commonjs-runtime-*.js',
          'assets/editor-*.js',
          'assets/markdown-*.js',
          'assets/katex-*.js',
        ],
        globIgnores: ['whiteboard-assets/**', 'assets/Assistant-*.woff2'],
        runtimeCaching: [{
          urlPattern: /\/(?:assets\/(?:pdfmake|pdfjs|mathjax|pdf\.worker)[^/]*\.(?:js|mjs)|fonts\/NotoSansSC-(?:Regular|Bold)\.otf)$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'easynote-pdf-v1',
            cacheableResponse: { statuses: [0, 200] },
          },
        }],
        navigateFallback: '/index.html',
        // Other applications share this origin. Only EasyNote routes use its cached shell.
        navigateFallbackAllowlist: [
          /^\/(?:\?.*)?$/,
          /^\/settings(?:\/[^?]*)?(?:\?.*)?$/,
          /^\/shared\/[a-f0-9]{64}(?:\?.*)?$/,
        ],
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/\.well-known\//, /^\/mcp/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __EASYNOTE_VERSION__: JSON.stringify(easynoteVersion),
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
        chunkFileNames(chunk) {
          if (chunk.moduleIds.some((id) => id.endsWith('/src/client/WhiteboardEditor.tsx'))) return 'assets/WhiteboardEditor-[hash].js';
          // The PWA shell precaches the index entry, while generic dependency index chunks load on demand.
          return chunk.name === 'index' ? 'assets/lazy-index-[hash].js' : 'assets/[name]-[hash].js';
        },
        manualChunks(id) {
          // Keep Rollup's shared interop helper out of the lazy MathJax chunk.
          if (id === '\0commonjsHelpers.js') return 'commonjs-runtime';
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
