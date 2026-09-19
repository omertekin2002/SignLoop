import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";
import animate from "tailwindcss-animate";

// Every colour resolves to a CSS variable from app/globals.css (the Dala tokens in /DESIGN.md).
// color-mix keeps Tailwind's opacity modifiers (`bg-primary/10`) working on hex-valued variables.
const token = (name: string) =>
  `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

// Tailwind v3 translation of DESIGN.md's Tailwind v4 `@theme` block. Spacing is intentionally not
// mapped: Dala's `--spacing-6: 6px` would silently redefine the default `p-6` (24px) everywhere,
// so use the stock scale where available and explicit values for the missing Dala steps.
export default {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.125rem" }],
        sm: ["0.9375rem", { lineHeight: "1.375rem" }],
        caption: ["var(--text-caption)", { lineHeight: "var(--leading-caption)" }],
        "nav-label": [
          "var(--text-nav-label)",
          { lineHeight: "var(--leading-nav-label)", letterSpacing: "var(--tracking-nav-label)" },
        ],
        body: ["var(--text-body)", { lineHeight: "var(--leading-body)" }],
        "heading-2xs": [
          "var(--text-heading-2xs)",
          { lineHeight: "var(--leading-heading-2xs)", letterSpacing: "var(--tracking-heading-2xs)" },
        ],
        "heading-xs": ["var(--text-heading-xs)", { lineHeight: "var(--leading-heading-xs)" }],
        subheading: ["var(--text-subheading)", { lineHeight: "var(--leading-subheading)" }],
        "heading-sm": [
          "var(--text-heading-sm)",
          { lineHeight: "var(--leading-heading-sm)", letterSpacing: "var(--tracking-heading-sm)" },
        ],
        heading: [
          "var(--text-heading)",
          { lineHeight: "var(--leading-heading)", letterSpacing: "var(--tracking-heading)" },
        ],
        "heading-lg": [
          "var(--text-heading-lg)",
          { lineHeight: "var(--leading-heading-lg)", letterSpacing: "var(--tracking-heading-lg)" },
        ],
        display: [
          "var(--text-display)",
          { lineHeight: "var(--leading-display)", letterSpacing: "var(--tracking-display)" },
        ],
      },
      letterSpacing: {
        // Dala tracks every display size (42px+) at -0.04em.
        display: "-0.04em",
      },
      fontFamily: {
        sans: ["var(--font-ppneuemontreal)"],
        ppneuemontreal: ["var(--font-ppneuemontreal)"],
      },
      maxWidth: {
        page: "var(--page-max-width)",
      },
      colors: {
        // Dala palette, named as in DESIGN.md.
        void: token("color-void"),
        "bone-white": token("color-bone-white"),
        "ash-gray": token("color-ash-gray"),
        "silver-mist": token("color-silver-mist"),
        "electric-iris": token("color-electric-iris"),
        "saffron-spark": token("color-saffron-spark"),
        "deep-verdant": token("color-deep-verdant"),

        // Semantic aliases used by the components.
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        highlight: token("highlight"),
        success: token("success"),
        "subtle-foreground": token("subtle-foreground"),
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
        },
        secondary: {
          DEFAULT: token("secondary"),
          foreground: token("secondary-foreground"),
        },
        destructive: {
          DEFAULT: token("destructive"),
          foreground: token("destructive-foreground"),
        },
        muted: {
          DEFAULT: token("muted"),
          foreground: token("muted-foreground"),
        },
        accent: {
          DEFAULT: token("accent"),
          foreground: token("accent-foreground"),
        },
        popover: {
          DEFAULT: token("popover"),
          foreground: token("popover-foreground"),
        },
        card: {
          DEFAULT: token("card"),
          foreground: token("card-foreground"),
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        "3xl": "var(--radius-3xl)",
        nav: "var(--radius-nav)",
        card: "var(--radius-cards)",
        button: "var(--radius-buttons)",
        tag: "var(--radius-tags)",
      },
      typography: {
        // `prose-dala`: assistant markdown on the void, set in the Dala text colours.
        dala: {
          css: {
            "--tw-prose-body": "var(--color-bone-white)",
            "--tw-prose-headings": "var(--color-bone-white)",
            "--tw-prose-lead": "var(--color-silver-mist)",
            "--tw-prose-links": "var(--color-saffron-spark)",
            "--tw-prose-bold": "var(--color-bone-white)",
            "--tw-prose-counters": "var(--color-ash-gray)",
            "--tw-prose-bullets": "var(--color-ash-gray)",
            "--tw-prose-hr": "var(--color-hairline)",
            "--tw-prose-quotes": "var(--color-silver-mist)",
            "--tw-prose-quote-borders": "var(--color-electric-iris)",
            "--tw-prose-captions": "var(--color-ash-gray)",
            "--tw-prose-code": "var(--color-bone-white)",
            "--tw-prose-pre-code": "var(--color-silver-mist)",
            "--tw-prose-pre-bg": "var(--color-void-raised)",
            "--tw-prose-th-borders": "var(--color-hairline-strong)",
            "--tw-prose-td-borders": "var(--color-hairline)",
          },
        },
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config;
