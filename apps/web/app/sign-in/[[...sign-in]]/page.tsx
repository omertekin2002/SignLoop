import { SignIn } from "@clerk/nextjs";
import { clerkAuthAppearance } from "@/lib/clerk-appearance";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-transparent px-4 py-12 sm:px-6 lg:px-8 relative">
       {/* Background decoration from globals.css applies to body, so we just need transparent/relative containers */}
      <div className="w-full max-w-md">
        <SignIn appearance={clerkAuthAppearance} />
      </div>
    </div>
  );
}
