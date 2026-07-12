import { SignIn } from "@clerk/nextjs";
import { clerkAuthAppearance } from "@/lib/clerk-appearance";

export default function SignInPage() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-transparent px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-6">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sign in to SignLoop
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Continue to your contract workspace.
          </p>
        </header>
        <SignIn appearance={clerkAuthAppearance} />
      </div>
    </div>
  );
}
