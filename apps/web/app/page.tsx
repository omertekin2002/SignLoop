'use client';

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight, FileText, MessagesSquare } from "lucide-react";
import { NumberTicker } from "@/components/number-ticker";
import { TypingAnimation } from "@/components/typing-animation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
    <div className="light relative flex min-h-screen flex-col overflow-x-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-cover bg-center bg-scroll md:bg-fixed"
        style={{ backgroundImage: "url('/background-landscape.png')" }}
      />
      <header className="absolute top-0 z-50 w-full">
        <div className="container mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight text-white drop-shadow-sm">SignLoop</span>
          </div>

          <nav className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm" className="text-white hover:text-white/80 hover:bg-white/10 font-medium">
              <Link href={isSignedIn ? "/dashboard" : "/sign-in"}>
                {isSignedIn ? "Open App" : "Get Started"}
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full relative">
        {/* Subtle Background Elements */}
        <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))] mix-blend-normal" />

        <div className="container mx-auto relative z-10 max-w-7xl space-y-24 px-4 py-24 sm:px-6 lg:px-8 lg:py-32">

          <section className="mx-auto flex max-w-[980px] flex-col items-center gap-8 text-center">
            <div className="inline-flex items-center rounded-full border border-border/50 bg-background/50 px-3 py-1 text-sm font-medium backdrop-blur transition-colors hover:bg-muted/50">
              <span className="flex h-2 w-2 rounded-full bg-primary/80 mr-2 animate-pulse" />
              SignLoop is now in Beta
            </div>

            <div className="space-y-6">
              <h1 className="min-h-[5em] text-4xl font-normal tracking-tight bg-gradient-to-br from-indigo-950 to-slate-700 bg-clip-text text-transparent sm:min-h-[2.5em] sm:text-5xl md:min-h-[2em] md:text-6xl lg:text-7xl font-[family-name:var(--font-eb-garamond)] whitespace-pre-wrap leading-normal">
                <TypingAnimation
                  text={"Review contracts with precision.\nNot guesswork."}
                  initialDelay={250}
                  typeSpeed={40}
                  persistCursor={false}
                  onComplete={() => setIsHeroTitleComplete(true)}
                  className="bg-gradient-to-br from-indigo-950 to-slate-700 bg-clip-text text-transparent drop-shadow-sm whitespace-pre-wrap inline-block pb-4"
                />
              </h1>
              <div className={cn("mx-auto max-w-[700px] min-h-[4rem] text-lg text-muted-foreground sm:text-xl opacity-0", isHeroTitleComplete && "animate-fade-in-up")} style={{ animationDelay: "0.1s" }}>
                <p>
                  SignLoop combines document ingestion, structured analysis workflows, model routing, and chat into one legal workspace.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row items-center justify-center pt-8">
              <Button asChild size="lg" className={cn("h-12 px-8 text-base border-t border-white/20 text-white hover:opacity-90 opacity-0", isHeroTitleComplete && "animate-fade-in-up")} style={{ animationDelay: "0.2s", backgroundColor: "#162044" }}>
                <Link href={isSignedIn ? "/dashboard" : "/sign-in"} tabIndex={isHeroTitleComplete ? 0 : -1} aria-hidden={!isHeroTitleComplete}>
                  {isSignedIn ? "Open Dashboard" : "Get Started Free"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </section>

          <section id="features" className="mx-auto w-full max-w-5xl -mt-8 sm:-mt-12">
            <div className="grid grid-cols-2 pt-4 pb-16 md:pt-8 md:pb-24">
              {stats.map((stat, index) => {
                return (
                  <div
                    key={stat.label}
                    className={cn(
                      "flex flex-col items-center justify-center space-y-8 opacity-0",
                      isHeroTitleComplete && "animate-fade-in-up"
                    )}
                    style={{ animationDelay: index === 0 ? "0.3s" : "0.4s" }}
                  >
                    <div className="flex items-baseline gap-1 font-[family-name:var(--font-eb-garamond)] font-normal tracking-tight text-7xl sm:text-8xl md:text-[7rem] leading-none text-white">
                      <NumberTicker
                        start={isHeroTitleComplete}
                        delay={index * 140}
                        useGrouping={stat.value >= 1000}
                        value={stat.value}
                      />
                      <span className="text-white/40 font-light ml-2">+</span>
                    </div>
                    <p className="text-sm sm:text-base font-[family-name:var(--font-eb-garamond)] uppercase tracking-[0.2em] font-medium text-white/60">
                      {stat.label}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>

        </div>
      </main>

      <footer className="w-full py-6 pb-8">
        <div className="container mx-auto flex max-w-7xl flex-col items-center justify-center gap-4 px-4 sm:px-6 md:flex-row md:justify-between lg:px-8">
          <p className="text-center text-sm leading-loose text-white/70 md:text-left">
            Built by{" "}
            <span className="font-medium text-white">SignLoop</span>. All rights reserved. © 2026.
          </p>
        </div>
      </footer>
    </div>
  );
}
