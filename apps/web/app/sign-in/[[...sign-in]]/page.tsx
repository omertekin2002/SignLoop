import { SignIn } from "@clerk/nextjs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8 relative">
       {/* Background decoration from globals.css applies to body, so we just need transparent/relative containers */}
      <div className="w-full max-w-md">
        <SignIn 
          appearance={{
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
              socialButtonsBlockButton: "bg-background border-input text-foreground hover:bg-accent hover:text-accent-foreground",
              socialButtonsBlockButtonText: "font-medium",
            }
          }}
        />
      </div>
    </div>
  );
}
