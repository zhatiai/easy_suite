# EasyNote technical stack and UI boundaries

Use this reference when a UI task touches architecture, dependencies, state, persistence, networking, the editor, or the build.

## Runtime and tooling

- Node.js 22.12 or newer, npm with the committed lockfile.
- React 19 and React DOM 19, written in strict TypeScript 5.9 with the automatic JSX runtime.
- Vite 6 with `@vitejs/plugin-react`; the app builds as a PWA through `vite-plugin-pwa` and Workbox.
- Plain global CSS in `src/client/styles.css`. There is no component library, CSS module layer, utility framework, or CSS-in-JS runtime.
- Playwright provides browser integration and responsive UI tests. Type and i18n checks run through `npm run check`.

## UI and content libraries

- `lucide-react` is the single UI icon family. Match the surrounding 12–20 px icon sizing and use accessible text or `aria-label` for icon-only actions.
- CodeMirror 6 powers Markdown editing. Editor styling intentionally inherits the product font, colors, selection, and line height.
- `markdown-it` renders Markdown; DOMPurify sanitizes it. `highlight.js` handles code syntax and Mermaid renders diagrams lazily.
- PDF export uses pdfmake, html-to-pdfmake, and pdfjs. Printed/PDF content has separate CSS constraints and must remain readable on white paper.
- `idb` backs offline drafts, cached sessions, the note mirror, sync cursor, and cached files.

## Product architecture relevant to UI

- `src/client/App.tsx`: top-level UI orchestration, page state, panels, dialogs, commands, responsive navigation, and user feedback.
- `src/client/Editor.tsx`: CodeMirror setup and secure Markdown preview behavior.
- `src/client/useNotebook.ts`: notebook domain state, autosave, incremental sync, WebSocket/poll fallback, offline behavior, and conflict handling.
- `src/client/api.ts`: browser request boundary, credentials, CSRF, timeouts, and unauthorized handling.
- `src/client/drafts.ts`: IndexedDB isolation and offline persistence.
- `src/client/i18n.ts`: paired Chinese/English strings and runtime language selection.
- Focused settings panels such as `AccountSecurity.tsx`, `AiAccess.tsx`, `NoteSharing.tsx`, `ShareManagement.tsx`, and `UserManagement.tsx` remain separate components.
- `src/shared/`: contracts and pure logic shared with the Cloudflare Worker. It must not depend on React or the DOM.

The backend is a Cloudflare Worker using D1 for structured data, private R2 for files, and Durable Object WebSockets for change notifications. UI code must preserve tenant isolation, Cookie + Origin + CSRF boundaries, optimistic `revision`, idempotent `operationId`, version history, tombstones, and offline conflict semantics.

## PWA and performance constraints

- The service worker caches only the application shell and selected PDF/font assets; it must not cache private API responses, cookies, or note bodies.
- Heavy editor, Markdown, Mermaid, and PDF dependencies are intentionally split or lazy-loaded. Avoid turning them into eager imports for small UI features.
- Use the established local state and browser APIs before adding dependencies. A new dependency needs a concrete benefit that cannot be met by existing primitives.
