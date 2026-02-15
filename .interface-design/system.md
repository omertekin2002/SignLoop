# SignLoop Interface System

## Direction and Feel
- Product domain: legal review desk, case folders, filings, annotation layers, evidence boards.
- User intent: quickly assess contract risk, compare context, and act from one operational view.
- Visual tone: precise, editorial, calm pressure.
- Signature element: thin top "ink rule" on cards plus squared components over parchment-inspired fields.

## Depth Strategy
- Primary strategy: borders-first with subtle surface shifts.
- Shadows are secondary and low-contrast; used only to separate stacked surfaces.
- Elevation hierarchy:
  - `surface-base` = workspace layer.
  - `surface-elevated` = card and list layer.
  - `surface-inset` = form control well/input bed.
- Border hierarchy:
  - soft: `--surface-stroke-soft`
  - default: `--surface-stroke`
  - strong: `--surface-stroke-strong`

## Spacing System
- Base unit: `4px`.
- Primary rhythm:
  - component padding: `12/16/20/24`
  - section spacing: `24`
  - major layout spacing: `32`
- Buttons: height-first scale (`h-9`, `h-11`, `h-12`) with compact uppercase labels.

## Token Principles
- Keep warm parchment/cocoa base in light mode and warm-charcoal inversion in dark mode.
- Accent color is singular and action-driven (`--accent`), never used as decorative noise.
- Background texture (aurora + grid + noise) remains low-opacity and never competes with content.
- Avoid transparent interactive controls when readability is affected.

## Core Component Patterns
- **App Shell**
  - Use `app-page`, `app-header`, `app-header-inner`, `app-main`.
  - Header should carry context + action buttons, not decorative blocks.
- **Cards**
  - Square corners, thin border, subtle top highlight rule.
  - Reuse for metrics, lists, settings, and detail sections.
- **Tabs as Command Rail**
  - Tabs sit in a bordered utility bar (`chrome-pane`) with actions aligned right.
- **Forms**
  - Inputs/selects/textareas are inset wells.
  - Select menus and triggers use opaque surfaces for legibility.
- **Badges**
  - Small uppercase metadata chips; semantic color only when meaning is explicit.
- **Chat**
  - User bubbles use accent tint.
  - Assistant bubbles stay neutral/elevated.
  - Thread list and composer sit on the same border system as dashboard panes.

## Reuse Rules
- New pages should start from shell classes and card patterns before custom styling.
- Default to square corners and border-led hierarchy.
- If a new component needs depth, use tokenized surface and stroke variables instead of ad-hoc RGBA.
