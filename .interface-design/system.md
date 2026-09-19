# SignLoop Interface System

The source of truth is `/DESIGN.md`: the Dala style reference plus the "SignLoop Implementation" section, which records every adaptation. This file is a quick orientation only.

## Direction and Feel
- Dala, "constellation floating on black velvet": pure black void, one Electric Iris (`#8052ff`) accent for action, Saffron Spark (`#ffb829`) for emphasis labels.
- Dark only. There is no light theme.
- Hierarchy comes from scale and tracking, never weight: headings are 400, long-form body is 18px / 200.
- Signature element: the particle constellation (`components/constellation.tsx`), used only in the landing hero.

## Depth Strategy
- Flat. No shadows and no gradients in UI (the logo and the constellation are the exceptions).
- Layers: void (`background`, `card`) → void-raised `#0c0c0c` (`popover`: menus, dialogs, toasts, composer).
- Hairlines: `border` `#1f1f1f` for structure only; `input` `#333333` for form controls.

## Spacing and Shape
- Dala uses a 6px base unit. Use Tailwind's equivalent steps (`1.5`, `3`, `4.5`, `6`, `7.5`, `9`, `15`, `24`, `30`); the Dala spacing tokens are not mapped into Tailwind.
- 24px radius for cards, dialogs, menus, and textareas (`rounded-card`); pills (`rounded-button` / `rounded-full`) for buttons, inputs, badges, and menu items.

## Core Component Patterns
- **Page header:** `.app-eyebrow` (Saffron uppercase label) → `.app-title` (36px, 42px from `md`) → `.app-lede`.
- **Buttons:** one filled Iris pill per view; `outline` hairline pill for secondary actions; `destructive` is a red outline pill.
- **Cards:** hairline, no fill, 24px radius; hover gets a lighter border plus a 3% white wash.
- **Empty and error states:** left-aligned eyebrow + heading + lede + a single CTA, with no dashed boxes.
- **Chat:** user messages in a Graphite bubble; assistant text floats with no container (`prose-dala`).
- **Risk:** high = Signal Red, medium = Saffron, low = Verdant Glow via `getRiskColor`.

## Reuse Rules
- Use semantic Tailwind tokens (`bg-background`, `text-muted-foreground`, `text-highlight`, and so on) or the Dala names (`text-saffron-spark`). Never raw palette classes (`text-amber-500`) or hex.
- Use `cn()` from `lib/utils.ts` so custom size and radius classes merge correctly.
