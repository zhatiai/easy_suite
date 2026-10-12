# EasyNote visual and interaction language

This is a concise specification of the current product. Confirm exact values in `src/client/styles.css` before editing.

## Design direction

EasyNote resembles a restrained Apple-native notes/productivity app rather than a promotional website:

- content-first, quiet, and functional;
- compact desktop density with generous document reading space;
- flat adjacent panes separated by hairlines, not a dashboard of floating cards;
- system typography and Lucide line icons;
- blue as the sole primary accent, with semantic red, amber, and green reserved for danger, pending/warning, and success;
- subtle hover fills and short transitions; shadows mainly for dialogs, transient overlays, the login panel, and the mobile compose button.

Avoid gratuitous gradients, glassmorphism, glow, large pill-shaped controls, oversized hero typography, colorful card grids, multiple competing accents, bouncy motion, and decorative illustrations. The avatar's small blue gradient is an existing exception, not a general pattern.

## Color and themes

Consume semantic variables instead of copying raw colors:

- surfaces: `--canvas`, `--paper`, `--sidebar`, `--list-pane`, `--elevated`, `--soft`, `--hover`;
- borders: `--line`, `--line-strong`;
- text: `--ink`, `--muted`, `--subtle`;
- action: `--accent`, `--accent-hover`, `--accent-soft`, `--accent-text`, `--primary`, `--primary-hover`;
- state: `--danger`, `--warning`, `--success`, `--focus-ring`;
- elevation: `--control-shadow`, `--panel-shadow`;
- syntax highlighting: the `--syntax-*` variables.

The default light theme uses cool system grays and iOS blue (`#007aff`). Dark mode switches to near-black gray surfaces and a brighter blue (`#0a84ff`). Light mode also offers pure-white and warm-paper variants through `data-theme="white"` and `data-theme="warm"`. Every new surface must work in all four appearances without theme-specific component forks.

Use `color-mix()` with semantic variables for restrained tinted states. Hard-coded color is acceptable only for an invariant medium such as white text on the primary button, the dark PDF preview stage, or print output.

## Typography and rhythm

- UI font stack: `-apple-system`, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, then Noto Sans SC and sans-serif.
- Standard control/body chrome is 12–14 px. Metadata is typically 10–12 px. Editor and rendered Markdown body are 16 px desktop and 15 px mobile with roughly 1.7 line height.
- The note title is 32 px desktop and 27 px mobile, weight around 650. Rendered headings step down from about 30/23/19 px.
- Use 600–700 weight for selected items, section identity, and primary hierarchy; keep supporting copy regular and muted.
- Existing spacing is compact and generally follows small 2–8 px gaps, 10–20 px control/panel padding, and larger 28–48 px document spacing.
- Corners are modest: most controls and panels use 7–8 px; small code/kbd/status elements use 3–6 px. Circular shapes are reserved for avatars, dots, clear controls, and the mobile compose action.
- Motion is quick and functional, generally 100–150 ms. Respect `prefers-reduced-motion`; never make motion necessary to understand state.

## Layout model

Desktop is a continuous pane workspace:

```text
200 px navigation | 220–440 px note list (300 default) | 5 px resizer | flexible document
```

- The sidebar and list have subtly different neutral surfaces; the document is the cleanest surface.
- The document is capped near 900 px, optionally 1080 px, with 40 px desktop side padding.
- Toolbars and footers use thin borders and fixed, compact heights rather than card containers.
- Optional knowledge/navigation detail appears as a narrow right panel, not a floating dashboard.

Responsive behavior is structural:

- At 1100 px, reduce document padding and hide nonessential width controls.
- At 900 px, hide the left sidebar and retain list + document.
- At 640 px and below, show either the note list or the document. Navigation becomes a left sheet; secondary note actions become a bottom sheet; a 54 px floating compose button is the main creation affordance.
- Honor `100dvh`, safe-area insets, sticky mobile headers, and bottom padding for floating controls.
- At 350 px and below, reduce toolbar spacing and collapse two-column mobile actions to one column.

Do not add horizontal scrolling at 320 px in either Chinese or English. Long titles, usernames, tags, translated labels, and filenames need `min-width: 0`, wrapping, truncation, or layout collapse as appropriate.

## Component patterns

- Buttons: 7 px radius, thin border, quiet shadow. Primary buttons are solid blue with white type. Destructive actions use semantic red and are not styled as primary unless the surrounding confirmation pattern already does so.
- Icon buttons: usually 28–32 px square, borderless, transparent, and muted; hover reveals a soft fill and accent color. Provide `aria-label`; desktop tooltips derive from the same localized label and are suppressed on touch/mobile.
- Navigation/list rows: flat and full-width. Selection uses `--accent-soft` plus `--accent-text`; separators disappear under hover/selection. Secondary row actions may reveal on hover or focus, but must remain keyboard reachable.
- Inputs/selects: 7 px radius, semantic surface and border, subtle shadow, blue border plus a 3 px focus ring. Search is an inset soft field rather than a separate card.
- Segmented controls: soft container with a lightly elevated selected segment and `aria-pressed` state.
- Dialogs: native `<dialog>`, typically 560 px maximum width, 8 px radius, thin border, one panel shadow, and a dim 3 px blurred backdrop. Actions align right. Use side sheets or bottom sheets for mobile navigation/actions.
- Feedback: persistent errors use inline alert strips; success uses small restrained toasts; progress and save state appear near the action or toolbar. Do not rely on color alone.
- Empty states: sparse, centered, and task-oriented, with one muted icon/title and at most one clear primary action.
- Settings: divided rows, simple labels and controls; complex forms use small grids that collapse to one column on mobile.
- Markdown/document: generous vertical rhythm, readable line length, quiet code blocks, simple tables and blockquotes, and no decorative card around the note itself.

## Interaction and accessibility

- Prefer native buttons, inputs, labels, dialogs, details, and headings. Keep existing roles such as `switch`, `status`, `alert`, and `aria-pressed` accurate.
- Every icon-only action needs a localized accessible name. Focus must be visible, and keyboard navigation must remain usable in menus, lists, dialogs, and resizers.
- Keep touch targets around 38–44 px for primary mobile navigation even when desktop controls are denser.
- Disabled, offline, pending, and destructive states must be explicit in copy or iconography as well as color.
- Keep feedback inside an open dialog when the action occurred there; otherwise use the app-level feedback area.
- Do not hide essential actions behind hover on touch devices.

## Completion checklist

- Uses existing tokens and patterns; no parallel design system.
- Looks correct in default, white, warm, and dark themes.
- Works at 1440x960 and at 320–390 px without clipped controls or horizontal overflow.
- Handles Chinese and longer English labels.
- Covers hover, focus, disabled, loading, empty, error, offline, and destructive states relevant to the change.
- Preserves keyboard and screen-reader semantics.
- Keeps document content visually dominant over application chrome.
