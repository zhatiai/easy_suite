---
name: easynote-ui-style
description: Guide EasyNote web UI implementation and review so changes preserve its existing React architecture, restrained Apple-inspired productivity style, responsive behavior, themes, i18n, accessibility, offline semantics, and verification conventions. Use for EasyNote UI, UX, CSS, components, editor, dialogs, navigation, responsive work, or visual review; do not apply to unrelated products.
---

# EasyNote UI Style

Keep new work visually and architecturally native to EasyNote. Extend the existing system instead of introducing a second design language.

## Load the relevant context

Before any UI change:

1. Read the repository `AGENTS.md` and `project.md`, then inspect `git status`.
2. Read [references/ui-language.md](references/ui-language.md). Treat it as a map, not a substitute for inspecting the current `src/client/styles.css`, affected JSX, and UI tests.
3. Read [references/technical-stack.md](references/technical-stack.md) when the task changes dependencies, component boundaries, state, browser storage, editor/preview behavior, networking, PWA behavior, or build configuration.
4. Inspect the exact component, its styles, its translations in `src/client/i18n.ts`, and nearby Playwright coverage before editing.

When this skill and current code differ, current code and tests are authoritative. Update this skill in the same change if the product's intentional design system has changed.

## Make the change

- Define the affected states before coding: desktop and mobile, light and dark, Chinese and English, plus relevant loading, empty, offline, error, disabled, focus, and destructive states.
- Keep UI orchestration in components, notebook domain state in `useNotebook.ts`, browser requests in `api.ts`, local/offline persistence in `drafts.ts`, and shared contracts in `src/shared/`.
- Reuse existing semantic CSS variables, primitives, Lucide icons, dialogs, icon-button behavior, feedback patterns, and responsive breakpoints. Add a token only when an existing semantic token cannot express the need.
- Make the smallest coherent change. Do not introduce a component framework, CSS-in-JS system, utility CSS framework, new icon family, or new font unless the user explicitly requests a design-system migration.
- Add both Chinese and English copy through `i18n.ts`; do not hard-code a new visible string in only one language.
- Preserve semantic HTML, keyboard access, visible focus, `aria-*` state, reduced-motion behavior, safe-area insets, text truncation, and narrow-screen overflow protection.
- Preserve autosave, revision, offline, conflict, upload, and security behavior. A visual refactor must not move domain logic into presentation code or bypass existing API boundaries.

## Preserve the product character

- Aim for a calm, content-first, native productivity tool: compact controls, strong information hierarchy, quiet surfaces, thin separators, and one blue accent.
- Prefer whitespace, alignment, typography, and subtle surface changes over decorative gradients, oversized cards, heavy shadows, glass effects, or animation.
- Keep content more prominent than chrome. Secondary actions stay muted until hover, focus, selection, or context makes them relevant.
- On mobile, preserve the intentional list-to-document navigation model and bottom-sheet/side-sheet actions; do not merely squeeze the desktop columns.

## Verify proportionally

For UI or styling changes, run at minimum:

```bash
npm run check
npm run test:ui
npm run build
```

Add focused Playwright coverage when behavior, responsive layout, i18n, accessibility state, or persistence changes. Check at least the standard desktop viewport and a narrow viewport around 320–390 px. Report commands actually run and any environment-limited gaps.
