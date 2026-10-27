# `@repo/eslint-config`

Shared ESLint flat configurations for this repository:

- `@repo/eslint-config/base` exports `config`: JavaScript/TypeScript rules, Prettier compatibility, and Turbo environment-variable checks.
- `@repo/eslint-config/next-js` exports `nextJsConfig`: the base rules plus React, React Hooks, Next.js and `eslint-plugin-jsx-a11y` recommended accessibility rules (for `.jsx`/`.tsx` files) and generated-file ignores.

The presets use `eslint-plugin-only-warn`; the web workspace runs ESLint with `--max-warnings 0`, so warnings still fail its lint command.
