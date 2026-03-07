'use client';

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { NumberTicker } from "@/components/number-ticker";
import { TypingAnimation } from "@/components/typing-animation";
import { Button } from "@/components/ui/button";

const stats = [
  {
    label: "Contracts Analyzed",
    value: 150,
  },
  {
    label: "Chat Interactions",
    value: 2000,
  },
] as const;

export default function Home() {
  const { isSignedIn } = useUser();
  const [isHeroTitleComplete, setIsHeroTitleComplete] = useState(false);

  return (
    <div className="app-page flex flex-col">
      <header className="app-header">
        <div className="app-header-inner">
          <p className="text-base font-semibold tracking-[0.06em] text-foreground">SignLoop</p>

          <nav className="flex items-center gap-2 sm:gap-3">
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="app-main flex-1 w-full space-y-8 pb-12">
        <section className="chrome-pane relative overflow-hidden rounded-[calc(var(--radius)+0.16rem)] p-8 md:p-12">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_22%,hsl(var(--accent)/0.2),transparent_44%),radial-gradient(circle_at_82%_16%,hsl(var(--primary)/0.18),transparent_42%)] dark:hidden" />
          <div className="relative max-w-3xl space-y-5">
            <h1 className="min-h-[2.6em] text-4xl leading-tight text-foreground md:min-h-[2.3em] md:text-6xl">
              <TypingAnimation
                text="Review contracts with precision, not guesswork."
                initialDelay={250}
                persistCursor={false}
                typeSpeed={38}
                onComplete={() => setIsHeroTitleComplete(true)}
              />
            </h1>
            <p className="max-w-2xl min-h-[6rem] text-base text-muted-foreground md:min-h-[4rem] md:text-lg">
              <TypingAnimation
                text="SignLoop combines document ingestion, structured analysis workflows, model routing, and chat into one legal workspace."
                cursorClassName="text-muted-foreground"
                initialDelay={180}
                start={isHeroTitleComplete}
                typeSpeed={18}
              />
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button asChild size="lg" className="px-8">
                <Link href={isSignedIn ? "/dashboard" : "/sign-in"}>
                  {isSignedIn ? "Open Dashboard" : "Get Started"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          {stats.map((stat, index) => (
            <article
              key={stat.label}
              className="chrome-pane relative overflow-hidden rounded-[calc(var(--radius)+0.16rem)] p-6 md:p-8"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--accent)/0.12),transparent_34%)]" />
              <div className="relative flex min-h-[200px] flex-col justify-end">
                <p className="font-[family:var(--font-fraunces)] text-[clamp(3.5rem,10vw,6.75rem)] font-semibold leading-none tracking-[-0.06em] text-foreground">
                  <NumberTicker delay={index * 140} useGrouping={stat.value < 1000} value={stat.value} />
                  <span className="text-[hsl(var(--accent))]">+</span>
                </p>
                <p className="mt-4 max-w-[12ch] text-sm text-muted-foreground md:text-base">
                  {stat.label}
                </p>
              </div>
            </article>
          ))}
        </section>

      </main>

      <footer className="border-t border-[var(--surface-stroke-soft)] bg-[var(--surface-base)] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 SignLoop</p>
        </div>
      </footer>
    </div>
  );
}
