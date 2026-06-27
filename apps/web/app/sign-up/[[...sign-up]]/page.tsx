import { SignUp } from "@clerk/nextjs";
import { clerkAuthAppearance } from "@/lib/clerk-appearance";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-transparent px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <SignUp appearance={clerkAuthAppearance} />
      </div>
    </div>
  );
}
