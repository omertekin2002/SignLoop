"use client";

import { useTheme } from "next-themes";

// Shared Clerk <SignIn>/<SignUp> appearance so the two auth pages can't drift apart.
// Clerk derives its colour scales from literal values, so the Dala tokens (DESIGN.md) and the
// `.light` overrides in globals.css are repeated here rather than read from CSS variables. Clerk's
// runtime CSS lands after Tailwind's, so outlines that must survive it use the `!` modifier.
const sharedVariables = {
  colorPrimary: "#8052ff", // --color-electric-iris
  colorPrimaryForeground: "#ffffff",
  colorRing: "#8052ff",
  colorShadow: "transparent",
  borderRadius: "1.5rem", // --radius-3xl
  fontFamily: "var(--font-ppneuemontreal)",
};

const darkVariables = {
  ...sharedVariables,
  colorBackground: "#000000", // --color-void
  colorForeground: "#ffffff", // --color-bone-white
  colorMutedForeground: "#9a9a9a", // --color-ash-gray
  colorNeutral: "#ffffff",
  colorInput: "#000000",
  colorInputForeground: "#ffffff",
  colorBorder: "#333333", // --color-hairline-strong
  colorDanger: "#ff5c5c", // --color-signal-red
  colorSuccess: "#3fc9a6", // --color-verdant-glow
  colorWarning: "#ffb829", // --color-saffron-spark
};

const lightVariables = {
  ...sharedVariables,
  colorBackground: "#ffffff",
  colorForeground: "#0a0a0a",
  colorMutedForeground: "#6b6b6b",
  colorNeutral: "#0a0a0a",
  colorInput: "#ffffff",
  colorInputForeground: "#0a0a0a",
  colorBorder: "#cfcfcf",
  colorDanger: "#d42a2a",
  colorSuccess: "#15846e", // --color-deep-verdant
  colorWarning: "#a35f00",
};

const elements = {
  rootBox: "w-full",
  cardBox: "w-full shadow-none border-none bg-transparent",
  card: "shadow-none border-none bg-transparent p-0 w-full",
  footer: "bg-none bg-transparent",
  headerTitle: "hidden",
  headerSubtitle: "hidden",
  formButtonPrimary:
    "rounded-full bg-primary text-[14px] font-semibold uppercase tracking-[0.025em] text-primary-foreground shadow-none hover:bg-primary/85",
  footerActionLink: "text-highlight hover:text-highlight/80",
  formFieldInput: "rounded-full !border !border-input bg-transparent !shadow-none",
  dividerLine: "bg-border",
  dividerText: "text-muted-foreground",
  socialButtonsBlockButton:
    "rounded-full !border !border-input bg-transparent text-foreground !shadow-none hover:bg-accent hover:text-accent-foreground",
  socialButtonsBlockButtonText: "font-normal",
};

export function useClerkAuthAppearance() {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  return {
    variables: isLight ? lightVariables : darkVariables,
    // The GitHub mark is black; it only needs inverting on the dark canvas.
    elements: { ...elements, socialButtonsProviderIcon__github: isLight ? "" : "invert" },
  };
}
