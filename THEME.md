# Cura Money Theme

This file is the source of truth for Cura Money's dark palette.
Palette values live in `src/ui/src/styles.css`; component code should use
semantic classes whenever possible.

## Theme Behavior

Cura Money is **dark only**. There is no light palette and no theme
preference. `src/ui/index.html` sets `<html class="dark">` statically so
third-party `dark:` styles resolve, `color-scheme` is `dark`, and the
browser `theme-color` and web manifest use the page canvas (`#0a0d12`).
App code never uses `dark:` variants or light/dark class pairs.

## Palette Ownership

| File | Role |
| --- | --- |
| `src/ui/src/styles.css` | Color scales, semantic tokens, components, charts |
| `src/ui/index.html` | Static `dark` class and browser metadata |
| `src/ui/public/manifest.webmanifest` | Static PWA startup colors |

Do not edit generated root `public/` assets.

## Color Strategy

Cool blue-gray neutrals a step darker than GitHub Dark support long sessions
with dense financial data. Cards are near-black and are separated from the
page by hairline borders rather than by a lighter grey fill; menus, popovers,
dialogs and sheets sit one tier brighter so they read as floating. Avoid
grey filled panels and boxes nested inside boxes.

Surface ladder, darkest to brightest:

| Tier | Value | Token / class | Use |
| --- | --- | --- | --- |
| Inset | `#07090d` | `--bg-inset`, `bg-inset` | Text fields, selects, date pickers |
| Page | `#0a0d12` | `--bg-page`, `bg-page`, `bg-background` | Main canvas |
| Card | `#0f1419` | `--bg-surface`, `bg-surface`, `bg-card` | Cards, alerts, tables |
| Elevated | `#151b23` | `--bg-elevated`, `bg-elevated`, `bg-popover` | Menus, popovers, dialogs, sheets, toasts |
| Subtle | `#171e27` | `--bg-canvas-subtle`, `bg-muted` | Hover rows, table heads, segmented tracks |
| Accent | `#1f2731` | `--accent`, `bg-accent` | Highlighted menu items, pressed toggles |

Subtle sits above elevated so hover states stay visible inside overlays.

The primary CTA remains fresh green (`#22c55e`). Its dark label (`#0d1117`)
passes AA and keeps the button more legible than white text would. Success uses
a quieter green, danger uses red, warnings use ochre-yellow, and purple is
reserved for depth and investment data.

## Semantic Tokens

| Role | Value | Token |
| --- | --- | --- |
| Main canvas | `#0a0d12` | `--bg-page` |
| Secondary canvas (subtle) | `#171e27` | `--bg-canvas-subtle` |
| Card surface | `#0f1419` | `--bg-surface` |
| Elevated surface | `#151b23` | `--bg-elevated` |
| Inset (fields) | `#07090d` | `--bg-inset` |
| Border | `#1f2630` | `--border-default` |
| Strong border | `#2d3540` | `--border-strong` |
| Control boundary | `#5f6975` | `--border-control` |
| Focus indicator | `#4ade80` | `--focus-ring` |
| Primary text | `#e6edf3` | `--fg-primary` |
| Secondary text | `#9198a1` | `--fg-secondary` |
| Tertiary text | `#b1bac4` | `--fg-tertiary` |
| Muted text | `#9198a1` | `--fg-muted` |
| Coffee accent | `#c58b5a` | `--coffee-accent` |

Exposed semantic classes include `.fg-primary`, `.fg-secondary`,
`.fg-tertiary`, `.fg-muted`, `.bg-page`, `.bg-canvas-subtle`, `.bg-surface`,
`.border-default`, and `.coffee-accent`.
Use `.border-control` for interactive control boundaries and `.focus-ring` for
custom interactive elements. Native form controls receive both tokens globally.

Product UI is built with shadcn/ui (Radix Nova). Cura semantic tokens also
drive the shadcn variables so primitives stay on the same palette:

| shadcn token | Cura source |
| --- | --- |
| `--background` | `--bg-page` |
| `--foreground` | `--fg-primary` |
| `--card` | `--bg-surface` |
| `--popover` | `--bg-elevated` |
| `--primary` | `--mp-amber-500` (green CTA) |
| `--primary-foreground` | `--mp-slate-900` |
| `--muted` | `--bg-canvas-subtle` |
| `--muted-foreground` | `--fg-muted` |
| `--accent` / `--accent-foreground` | `#1f2731` / `--fg-primary` |
| `--destructive` | `--mp-rose-500` |
| `--border` | `--border-default` |
| `--input` | `--border-control` |
| `--ring` | `--focus-ring` |

Prefer shadcn components (`Button`, `Card`, `Dialog`, `AlertDialog`, `Sheet`,
`Drawer`, `Input`, `Select`, `Field`, `Alert`, `Empty`, `Table`, `Badge`,
`DropdownMenu`) over custom markup. Overlay stacking, titles, and focus belong
to those primitives — do not rebuild them with generic `fixed`/`inset`/`z-*`
utility combinations. Bottom sheets use `Drawer`.

## Accent Roles

| Role | Foreground | Core/action |
| --- | --- | --- |
| Primary | `#4ade80` | `#22c55e` |
| Success | `#56d364` | `#3fb950` |
| Danger | `#ff6e64` | `#ff7b72` |
| Warning | `#d29922` | ochre-yellow |
| Depth | `#d2a8ff` | purple |

Tailwind's historical `amber-*` scale is the primary green scale. Keep that
mapping to avoid a broad component migration. The accent scales are
intentionally role-driven rather than monotonic: `200/300/400` are light
readable foregrounds while `50/100/900` provide dark tinted surfaces.

## Chart Tokens

| Token | Value |
| --- | --- |
| `--chart-grid` | `#1f2630` |
| `--chart-axis` | `#9198a1` |
| `--chart-tooltip-bg` | `#151b23` |
| `--chart-tooltip-border` | `#2d3540` |
| `--chart-tooltip-fg` | `#e6edf3` |
| `--chart-tooltip-muted` | `#9198a1` |
| `--chart-total` | `#e6edf3` |
| `--chart-baseline` | `#22c55e` |
| `--chart-orange` | `#ffa657` |
| `--chart-income` | `#56d364` |
| `--chart-expense` | `#ff6e64` |
| `--chart-net` | `#d29922` |
| `--chart-comparison` | `#8b949e` |
| `--chart-merchant` | `#d2a8ff` |
| `--chart-net-worth-positive` | `#d29922` |
| `--chart-net-worth-negative` | `#ff6e64` |
| `--chart-category-1` | `#d29922` |
| `--chart-category-2` | `#56d364` |
| `--chart-category-3` | `#ff6e64` |
| `--chart-category-4` | `#58a6ff` |
| `--chart-category-5` | `#d2a8ff` |
| `--chart-category-6` | `#ffa657` |
| `--chart-category-7` | `#39c5cf` |
| `--chart-category-8` | `#afb8c1` |
| `--chart-excluded` | `#68737f` |

The eight category tokens form the shared category/account cycle. Every value
is unique and retains at least 3:1 contrast against every surface it is
drawn on, up to the elevated tier (`#151b23`). Series
still use labels, tooltips, and accessible data tables rather than color alone.

That contrast holds for strokes, not for compounded fills. Where several series
overlap without stacking — the Pay down page's per-account payoff curves —
translucent fills pile up into one flat tint that no longer separates the
tokens, so those series render as strokes alone and only a lone series takes a
filled gradient. Stacked or single-series charts (Reports cash flow, net worth)
keep their gradient fills, since nothing overlaps to compound.

## Rules

1. Define palette values only in `src/ui/src/styles.css`; do not place hex
   colors in component files.
2. Update this file whenever palette values or theme behavior change.
3. Amber/primary buttons use dark text, never white.
4. Prefer semantic classes for surfaces, body text, and borders.
5. Never add `dark:` variants or light/dark class pairs; there is one
   palette. Accent treatments without a semantic class use the role scales
   directly (for example `text-emerald-400`, `bg-rose-900/20`).
6. Meaningful normal text, including tertiary and muted labels, must maintain
   at least 4.5:1 against its surface. Decorative content may use opacity only
   when it does not communicate information.
7. Interactive control boundaries and focus indicators must maintain at least
   3:1 against adjacent surfaces. Use `--border-control` and `--focus-ring`;
   `--border-default` remains available for non-interactive dividers.
8. The global focus default excludes `tabindex="-1"` containers and components
   with explicit `focus-visible:outline-none` or `focus-visible:ring-*` styles,
   preventing a second indicator from being layered over component-owned rings.
9. If the page canvas changes, update the `theme-color` meta in
   `src/ui/index.html` and the static manifest colors.
10. Composite inputs keep their control border neutral and place the focus
    outline on their shared wrapper so icons and text fields receive one
    continuous focus indicator.

## Verification

```bash
bun run lint
bun run typecheck
(cd src/ui && bun run build)
```

Check overlays (menus, popovers, dialogs, sheets) against cards and the page:
hover and selected states must stay visible on the elevated tier.
