import { SignUp } from "@clerk/nextjs";
import { clerkAuthAppearance } from "@/lib/clerk-appearance";

export default function SignUpPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-transparent px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-3 text-center">
          <p className="app-eyebrow">Get started</p>
          <h1 className="text-heading-2xs sm:text-subheading">
            Create your SignLoop account
          </h1>
          <p className="text-sm text-muted-foreground">
            Set up a workspace for contracts and legal context.
          </p>
        </header>
        <SignUp appearance={clerkAuthAppearance} />
      </div>
    </div>
  );
}
