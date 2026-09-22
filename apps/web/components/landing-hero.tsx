"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { Constellation, findScrollParent } from "@/components/constellation";
import { TypingAnimation } from "@/components/typing-animation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const manifesto = [
  "Every contract hides something. A renewal that rolls over in silence. An indemnity with no cap. A termination clause written for the other side.",
  "Reading every line takes hours you don't have. Skimming costs you later.",
];

const formats = ["PDF", "DOCX", "DOC", "TXT", "JPG", "PNG", "TIFF"];

const analysisOutputs = [
  "Red flags, ranked by severity",
  "Obligations, parties, and key dates",
  "What's normal in your region",
  "Next actions you can take today",
];

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// Maps the scroller position to a fractional constellation stage. Each section holds its shape
// while it is centred and morphs to the next shape across the gap between section centres.
function useScrollStage(rootRef: React.RefObject<HTMLDivElement | null>) {
  const stageRef = useRef(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const scroller = root ? findScrollParent(root) : null;
    if (!root || !scroller) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollerRect = scroller.getBoundingClientRect();
      const height = scroller.clientHeight;
      const sections = Array.from(
        root.querySelectorAll<HTMLElement>("[data-stage]"),
      );
      const anchors = sections.map((section) => {
        const rect = section.getBoundingClientRect();
        return (
          rect.top -
          scrollerRect.top +
          scroller.scrollTop +
          rect.height / 2 -
          height / 2
        );
      });
      const position = scroller.scrollTop;
      let stage = 0;
      if (anchors.length > 1 && position > anchors[0]!) {
        stage = anchors.length - 1;
        for (let index = 0; index < anchors.length - 1; index += 1) {
          const start = anchors[index]!;
          const end = anchors[index + 1]!;
          if (position < end) {
            stage =
              index +
              smoothstep(
                0.15,
                0.85,
                (position - start) / Math.max(1, end - start),
              );
            break;
          }
        }
      }
      stageRef.current = stage;

      // Scroll-lit copy: `--p` runs 0 → 1 as the block travels up through the viewport.
      for (const block of root.querySelectorAll<HTMLElement>(
        "[data-scroll-lit]",
      )) {
        const rect = block.getBoundingClientRect();
        const progress =
          (scrollerRect.top + height * 0.85 - rect.top) /
          (rect.height + height * 0.35);
        block.style.setProperty(
          "--p",
          Math.min(1, Math.max(0, progress)).toFixed(3),
        );
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    const resizeObserver = new ResizeObserver(() => {
      setViewportHeight(scroller.clientHeight);
      schedule();
    });
    resizeObserver.observe(scroller);
    resizeObserver.observe(root);
    scroller.addEventListener("scroll", schedule, { passive: true });
    update();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [rootRef]);

  return { stageRef, viewportHeight };
}

// Fades and lifts `[data-reveal]` children into place the first time they enter the scroller.
function useReveal(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-shown", "");
          observer.unobserve(entry.target);
        }
      },
      { root: findScrollParent(root), threshold: 0.25 },
    );
    for (const element of root.querySelectorAll("[data-reveal]"))
      observer.observe(element);
    return () => observer.disconnect();
  }, [rootRef]);
}

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      data-reveal=""
      className={cn("landing-reveal", className)}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

function ScrollLit({ text, className }: { text: string; className?: string }) {
  const words = text.split(" ");
  return (
    <p data-scroll-lit="" className={className}>
      {words.map((word, index) => (
        <span
          key={index}
          className="landing-lit-word"
          style={{ "--i": (index / words.length).toFixed(3) } as CSSProperties}
        >
          {word}{" "}
        </span>
      ))}
    </p>
  );
}

function Section({
  stage,
  align,
  children,
}: {
  stage: number;
  align: "left" | "right" | "center";
  children: ReactNode;
}) {
  return (
    <section
      data-stage={stage}
      className={cn(
        "relative mx-auto flex min-h-[var(--landing-vh)] w-full max-w-page flex-col justify-center px-6 py-24 sm:px-10 lg:px-16",
        align === "center" && "items-center text-center",
        align === "right" && "lg:items-end",
      )}
    >
      <div
        className={cn(
          "w-full",
          align === "center" ? "max-w-[860px]" : "max-w-[520px]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function focusComposer() {
  document
    .querySelector<HTMLTextAreaElement>('textarea[aria-label="Chat message"]')
    ?.focus();
}

// Dala-style landing: one sticky 3D constellation behind a column of sections. Scrolling morphs
// it brain → dust → contract stack → risk skyline → routing network → SignLoop mark; the pointer
// tilts it, dragging spins it, and clicks send a shockwave through it.
export function LandingHero() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isHeroTitleComplete, setIsHeroTitleComplete] = useState(false);
  const { stageRef, viewportHeight } = useScrollStage(rootRef);
  useReveal(rootRef);

  return (
    <div
      ref={rootRef}
      className="relative -mx-4 -my-6 overflow-x-clip"
      style={
        {
          "--landing-vh": viewportHeight
            ? `${viewportHeight}px`
            : "calc(100dvh - 8.5rem)",
        } as CSSProperties
      }
    >
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="sticky top-0 h-[var(--landing-vh)]">
          <Constellation stageRef={stageRef} interactionRef={rootRef} />
        </div>
      </div>

      <div className="relative">
        <section
          data-stage={0}
          className="mx-auto flex min-h-[var(--landing-vh)] w-full max-w-page flex-col justify-center px-6 py-12 sm:px-10 lg:px-16"
        >
          <div className="flex max-w-[620px] flex-col items-start text-left">
            <h1 className="min-h-[4.8em] whitespace-pre-wrap text-heading-sm font-normal sm:min-h-[3.3em] sm:text-heading lg:text-heading-lg">
              <TypingAnimation
                text={"Review contracts with precision.\nNot guesswork."}
                initialDelay={250}
                typeSpeed={40}
                persistCursor={false}
                onComplete={() => setIsHeroTitleComplete(true)}
                className="whitespace-pre-wrap"
                cursorClassName="text-primary"
              />
            </h1>

            <div
              className={cn(
                "mt-8 max-w-[480px] space-y-4 opacity-0",
                isHeroTitleComplete && "animate-fade-in-up",
              )}
              style={{ animationDelay: "0.1s" }}
            >
              <p className="app-eyebrow">SignLoop is now in beta</p>
              <p className="text-body font-extralight text-foreground">
                SignLoop combines document ingestion, structured analysis
                workflows, model routing, and chat into one legal workspace.
              </p>
            </div>
          </div>

          <div
            className={cn(
              "mt-16 flex items-center gap-3 text-caption uppercase tracking-[0.04em] text-muted-foreground opacity-0",
              isHeroTitleComplete && "animate-fade-in-up",
            )}
            style={{ animationDelay: "0.6s" }}
          >
            <span className="landing-scroll-cue relative flex h-8 w-5 justify-center rounded-full border border-input">
              <ArrowDown className="mt-1.5 h-3 w-3" />
            </span>
            Scroll to explore · drag to spin
          </div>
        </section>

        <Section stage={1} align="center">
          <Reveal>
            <p className="app-eyebrow mb-8">The problem</p>
          </Reveal>
          <div className="space-y-10">
            {manifesto.map((paragraph) => (
              <ScrollLit
                key={paragraph}
                text={paragraph}
                className="text-heading-2xs font-normal sm:text-subheading lg:text-heading-sm"
              />
            ))}
          </div>
        </Section>

        <Section stage={2} align="left">
          <Reveal>
            <p className="app-eyebrow">01 · Ingest</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mt-6 text-heading-sm font-normal lg:text-heading-lg">
              Bring your documents.
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="app-lede mt-8">
              Drop in a PDF, a Word file, or a phone photo of a signed page.
              SignLoop extracts document text and uses OCR for image uploads.
              Scanned PDFs need a usable text layer.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <ul
              className="mt-10 flex flex-wrap gap-2"
              aria-label="Supported formats"
            >
              {formats.map((format) => (
                <li
                  key={format}
                  className="rounded-full border border-input px-3 py-1 text-caption tracking-[0.04em] text-subtle-foreground"
                >
                  {format}
                </li>
              ))}
            </ul>
          </Reveal>
        </Section>

        <Section stage={3} align="right">
          <Reveal>
            <p className="app-eyebrow">02 · Analyze</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mt-6 text-heading-sm font-normal lg:text-heading-lg">
              Risk, clause by clause.
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="app-lede mt-8">
              Structured analysis rates each contract low, medium, or high risk,
              then shows its working. The clauses that matter rise to the top.
              Long documents are analyzed using bounded excerpts, with coverage
              notices in the result.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <ul className="mt-10 divide-y divide-border border-y border-border">
              {analysisOutputs.map((output, index) => (
                <li
                  key={output}
                  className="flex items-baseline gap-5 py-4 text-body font-extralight"
                >
                  <span className="text-caption tabular-nums text-primary">
                    0{index + 1}
                  </span>
                  {output}
                </li>
              ))}
            </ul>
          </Reveal>
        </Section>

        <Section stage={4} align="left">
          <Reveal>
            <p className="app-eyebrow">03 · Route</p>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="mt-6 text-heading-sm font-normal lg:text-heading-lg">
              Model choice, with fallback.
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="app-lede mt-8">
              Choose a model in Settings. If it cannot start answering, SignLoop
              can try a fallback. A response interrupted after it begins needs a
              retry.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <p className="app-lede mt-6">
              Then keep talking. Ask chat to find and read your saved contracts.
              Project reference documents inform structured analysis through
              bounded excerpts.
            </p>
          </Reveal>
        </Section>

        <Section stage={5} align="center">
          <Reveal>
            <h2 className="text-heading-sm font-normal sm:text-heading">
              Your contracts have the answers.
              <br />
              Ask SignLoop to find them.
            </h2>
          </Reveal>
          <Reveal delay={160} className="mt-10 flex justify-center">
            <Button type="button" size="lg" onClick={focusComposer}>
              Start a review
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Reveal>
        </Section>
      </div>
    </div>
  );
}
