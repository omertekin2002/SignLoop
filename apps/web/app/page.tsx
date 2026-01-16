'use client';

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, FileText, Shield, Zap } from 'lucide-react';

export default function Home() {
  const { isSignedIn } = useUser();

  if (isSignedIn) {
     // If signed in, redirect logic is handled by middleware usually, but here we can show a "Go to Dashboard"
     // Or we can just redirect in useEffect. For now, let's just show the button.
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Hero Section */}
      <header className="px-4 lg:px-6 h-14 flex items-center border-b bg-background/60 backdrop-blur sticky top-0 z-50">
        <div className="flex items-center justify-center">
          <FileText className="h-6 w-6 mr-2 text-primary" />
          <span className="font-bold text-xl text-foreground">SignLoop</span>
        </div>
        <nav className="ml-auto flex gap-4 sm:gap-6">
          <Link className="text-sm font-medium hover:underline underline-offset-4" href="#features">
            Features
          </Link>
          <Link className="text-sm font-medium hover:underline underline-offset-4" href="/dashboard">
            Dashboard
          </Link>
        </nav>
      </header>
      <main className="flex-1">
        <section className="w-full py-12 md:py-24 lg:py-32 xl:py-48 relative overflow-hidden">
             {/* Background decoration from globals.css will handle the glow */}
          <div className="container px-4 md:px-6 relative z-10">
            <div className="flex flex-col items-center space-y-4 text-center">
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none font-serif">
                  Understand Contracts in Seconds
                </h1>
                <p className="mx-auto max-w-[700px] text-muted-foreground md:text-xl font-sans">
                  AI-powered legal analysis to spot risks, summarize terms, and sign with confidence.
                </p>
              </div>
              <div className="space-x-4">
                <Link href={isSignedIn ? "/dashboard" : "/sign-in"}>
                  <Button size="lg" className="h-11 px-8">
                    {isSignedIn ? "Go to Dashboard" : "Get Started"} <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
                <Link href="#features">
                  <Button variant="outline" size="lg" className="h-11 px-8">
                    Learn more
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </section>
        
        <section id="features" className="w-full py-12 md:py-24 lg:py-32 bg-card/50 backdrop-blur-sm border-t border-border">
          <div className="container px-4 md:px-6">
            <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col items-center space-y-4 text-center">
                <div className="p-4 bg-primary/10 rounded-full">
                  <Zap className="h-6 w-6 text-primary" />
                </div>
                <h2 className="text-xl font-bold font-serif">Instant Summaries</h2>
                <p className="text-muted-foreground font-sans">
                  Get plain English summaries of complex legal terms immediately.
                </p>
              </div>
              <div className="flex flex-col items-center space-y-4 text-center">
                <div className="p-4 bg-destructive/10 rounded-full">
                  <Shield className="h-6 w-6 text-destructive" />
                </div>
                <h2 className="text-xl font-bold font-serif">Risk Detection</h2>
                <p className="text-muted-foreground font-sans">
                  Automatically flag high-risk clauses and unusual terms.
                </p>
              </div>
              <div className="flex flex-col items-center space-y-4 text-center">
                <div className="p-4 bg-accent rounded-full">
                  <FileText className="h-6 w-6 text-accent-foreground" />
                </div>
                <h2 className="text-xl font-bold font-serif">Context Aware</h2>
                <p className="text-muted-foreground font-sans">
                  Upload related documents to get analysis tailored to your project.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="flex flex-col gap-2 sm:flex-row py-6 w-full shrink-0 items-center px-4 md:px-6 border-t bg-background/80 backdrop-blur-sm">
        <p className="text-xs text-muted-foreground">© 2026 SignLoop. All rights reserved.</p>
        <nav className="sm:ml-auto flex gap-4 sm:gap-6">
          <Link className="text-xs hover:underline underline-offset-4" href="#">
            Terms of Service
          </Link>
          <Link className="text-xs hover:underline underline-offset-4" href="#">
            Privacy
          </Link>
        </nav>
      </footer>
    </div>
  );
}