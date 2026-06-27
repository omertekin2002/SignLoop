// Shared Clerk <SignIn>/<SignUp> appearance so the two auth pages can't drift apart.
export const clerkAuthAppearance = {
  elements: {
    rootBox: "w-full",
    card: "shadow-none border-none bg-transparent p-0 w-full",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90",
    footerActionLink: "text-primary hover:text-primary/90",
    formFieldInput: "bg-background border-input",
    dividerLine: "bg-border",
    dividerText: "text-muted-foreground",
    socialButtonsBlockButton:
      "bg-background border-input text-foreground hover:bg-accent hover:text-accent-foreground",
    socialButtonsBlockButtonText: "font-medium",
  },
} as const;
