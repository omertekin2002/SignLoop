'use client';

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight, FileText, MessagesSquare } from "lucide-react";
import { NumberTicker } from "@/components/number-ticker";
import { TypingAnimation } from "@/components/typing-animation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const stats = [
  {
    label: "Contracts Analyzed",
    value: 150,
    icon: FileText,
  },
  {
    label: "Chat Interactions",
    value: 2000,
    icon: MessagesSquare,
  },
] as const;

export default function Home() {
  const { isSignedIn } = useUser();
  const [isHeroTitleComplete, setIsHeroTitleComplete] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-transparent">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight">SignLoop</span>
          </div>

          <nav className="flex items-center gap-2 sm:gap-3">
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={isSignedIn ? "/dashboard" : "/sign-in"}>
                {isSignedIn ? "Open App" : "Get Started"}
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full relative">
        {/* Subtle Background Elements */}
        <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))] mix-blend-normal dark:bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.3),rgba(255,255,255,0))]" />
        
        <div className="container mx-auto relative z-10 max-w-7xl space-y-24 px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
          
          <section className="mx-auto flex max-w-[980px] flex-col items-center gap-8 text-center">
            <div className="inline-flex items-center rounded-full border border-border/50 bg-background/50 px-3 py-1 text-sm font-medium backdrop-blur transition-colors hover:bg-muted/50">
              <span className="flex h-2 w-2 rounded-full bg-primary/80 mr-2 animate-pulse" />
              SignLoop is now in Beta
            </div>

            <div className="space-y-6">
              <h1 className="min-h-[2.5em] text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl md:min-h-[2em] md:text-6xl lg:text-7xl">
                <TypingAnimation
                  text="Review contracts with precision. Not guesswork."
                  initialDelay={250}
                  persistCursor={false}
                  typeSpeed={55}
                  onComplete={() => setIsHeroTitleComplete(true)}
                />
              </h1>
              <div className="mx-auto max-w-[700px] min-h-[4rem] text-lg text-muted-foreground sm:text-xl">
                <TypingAnimation
                  text="SignLoop combines document ingestion, structured analysis workflows, model routing, and chat into one legal workspace."
                  cursorClassName="text-muted-foreground"
                  initialDelay={180}
                  start={isHeroTitleComplete}
                  typeSpeed={40}
                />
              </div>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row items-center justify-center pt-8">
              <Button asChild size="lg" className="h-12 px-8 text-base">
                <Link href={isSignedIn ? "/dashboard" : "/sign-in"}>
                  {isSignedIn ? "Open Dashboard" : "Get Started Free"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-12 px-8 text-base">
                <Link href="#features">
                  Learn More
                </Link>
              </Button>
            </div>
          </section>

          <section id="features" className="mx-auto max-w-5xl">
            <div className="grid gap-6 md:grid-cols-2">
              {stats.map((stat, index) => {
                const Icon = stat.icon;
                return (
                  <Card
                    key={stat.label}
                    className="group relative overflow-hidden glass-card p-8 pt-10 transition-colors hover:bg-background/60"
                  >
                    <div className="relative z-10 flex flex-col items-center text-center space-y-4">
                      <div className="p-3 rounded-full bg-primary/10 text-primary mb-2">
                        <Icon className="h-6 w-6" />
                      </div>
                      <div className="flex items-baseline justify-center gap-1 font-bold tracking-tighter text-5xl sm:text-6xl lg:text-7xl text-foreground">
                        <NumberTicker 
                          delay={index * 140} 
                          useGrouping={stat.value < 1000} 
                          value={stat.value} 
                        />
                        <span className="text-primary">+</span>
                      </div>
                      <p className="text-lg font-medium text-muted-foreground">
                        {stat.label}
                      </p>
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>

        </div>
      </main>

      <footer className="w-full border-t border-border/40 py-6">
        <div className="container mx-auto flex max-w-7xl flex-col items-center justify-center gap-4 px-4 sm:px-6 md:flex-row md:justify-between lg:px-8">
          <p className="text-center text-sm leading-loose text-muted-foreground md:text-left">
            Built by{" "}
            <span className="font-medium text-foreground">SignLoop</span>. All rights reserved. © 2026.
          </p>
        </div>
      </footer>
    </div>
  );
}
