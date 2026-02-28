'use client';

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { ArrowRight, FileText, MessageSquareText, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const features = [
  {
    title: "Clause-aware analysis",
    description: "Extract obligations, detect red flags, and produce actionable summaries in one pass.",
    icon: FileText,
  },
  {
    title: "Context-driven review",
    description: "Attach legal references, prior agreements, and policy docs to ground model reasoning.",
    icon: Scale,
  },
  {
    title: "Persisted legal chat",
    description: "Use chat threads for follow-up questions while keeping model and personality controls in settings.",
    icon: MessageSquareText,
  },
];

export default function Home() {
  const { isSignedIn } = useUser();

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

      <main className="app-main flex-1 space-y-8 pb-12">
        <section className="chrome-pane relative overflow-hidden rounded-[calc(var(--radius)+0.16rem)] p-8 md:p-12">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_22%,hsl(var(--accent)/0.2),transparent_44%),radial-gradient(circle_at_82%_16%,hsl(var(--primary)/0.18),transparent_42%)] dark:hidden" />
          <div className="relative max-w-3xl space-y-5">
            <h1 className="text-4xl leading-tight text-foreground md:text-6xl">
              Review contracts with precision, not guesswork.
            </h1>
            <p className="max-w-2xl text-base text-muted-foreground md:text-lg">
              SignLoop combines document ingestion, structured analysis workflows, model routing, and chat into one legal workspace.
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

        <section id="features" className="grid gap-4 md:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <Card key={feature.title}>
                <CardHeader className="space-y-3">
                  <div className="grid h-10 w-10 place-items-center rounded-[var(--radius)] border border-[var(--surface-stroke)] bg-[var(--surface-elevated)]">
                    <Icon className="h-5 w-5 text-[hsl(var(--accent))]" />
                  </div>
                  <CardTitle className="text-xl">{feature.title}</CardTitle>
                  <CardDescription>{feature.description}</CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </section>

      </main>

      <footer className="border-t border-[var(--surface-stroke-soft)] bg-[var(--surface-base)] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 SignLoop</p>
          <p>Contract analysis workspace</p>
        </div>
      </footer>
    </div>
  );
}
