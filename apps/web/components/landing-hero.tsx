"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
// while it is centred and morphs to the next shape across nearly the whole gap between section
// centres, so a slide glide spends almost all of its time mid-morph.
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
                0.05,
                0.95,
                (position - start) / Math.max(1, end - start),
              );
            break;
          }
        }
      }
      stageRef.current = stage;
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

// Long and evenly paced so the morph between shapes gets room to play out.
const GLIDE_MS = 2000;
const SETTLE_MS = 500;
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

// Scroll range in which a slide is at rest. A slide that fits the viewport rests at one position
// (centred); a taller one rests anywhere from its top edge to its bottom edge.
type Slide = { start: number; end: number };

// Sections carry 64px of vertical padding each side, so overflow up to this much only trims
// padding when centred; treating those as tall slides would cost an extra gesture for nothing.
const PADDING_OVERFLOW = 120;

// Pages the landing one slide at a time so it never rests between shapes. Wheels, trackpads, and
// keys glide to the next slide, and one gesture moves one slide however hard it flicks; scrollbar
// drags and focus or find-in-page jumps settle onto the nearest slide. Touch devices use native
// CSS snapping instead (`.landing-snap`), which feels right under a finger.
function useSlideSnap(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = root ? findScrollParent(root) : null;
    if (!root || !scroller) return;

    if (window.matchMedia("(pointer: coarse)").matches) {
      scroller.classList.add("landing-snap");
      return () => scroller.classList.remove("landing-snap");
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Frame-by-frame scrollTop writes would each start a smooth scroll under `scroll-smooth`.
    const previousBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";

    let animation = 0;
    let animating = false;
    let settleTimer = 0;
    let draggingScrollbar = false;
    // Wheel gesture tracking: after a page turn, further events belong to the same gesture (or its
    // trackpad momentum) until the wheel goes quiet or a fresh, stronger swipe begins.
    let locked = false;
    let lastWheel = 0;
    let accumulated = 0;
    const recentDeltas: number[] = [];

    const slides = (): Slide[] => {
      const height = scroller.clientHeight;
      const max = scroller.scrollHeight - height;
      const offset = scroller.scrollTop - scroller.getBoundingClientRect().top;
      const clamp = (value: number) => Math.min(max, Math.max(0, value));
      return Array.from(
        root.querySelectorAll<HTMLElement>("[data-stage]"),
        (section) => {
          const rect = section.getBoundingClientRect();
          const top = rect.top + offset;
          if (rect.height <= height + PADDING_OVERFLOW) {
            const anchor = clamp(top + rect.height / 2 - height / 2);
            return { start: anchor, end: anchor };
          }
          return { start: clamp(top), end: clamp(top + rect.height - height) };
        },
      );
    };

    const glideTo = (target: number, duration = GLIDE_MS) => {
      cancelAnimationFrame(animation);
      const from = scroller.scrollTop;
      const distance = target - from;
      if (Math.abs(distance) < 1 || duration <= 0 || reducedMotion.matches) {
        scroller.scrollTop = target;
        animating = false;
        return;
      }
      animating = true;
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / duration);
        scroller.scrollTop = from + distance * easeInOutSine(t);
        if (t < 1) animation = requestAnimationFrame(step);
        else animating = false;
      };
      animation = requestAnimationFrame(step);
    };

    // Moves one step: through the rest of a tall slide first (by `amount`), then to the next slide.
    // Returns "inside" when it only scrolled within the current slide.
    const advance = (direction: 1 | -1, amount: number, smooth: boolean) => {
      const list = slides();
      const position = scroller.scrollTop;
      const current = list.find(
        (slide) => position >= slide.start - 2 && position <= slide.end + 2,
      );
      if (current) {
        const edge = direction > 0 ? current.end : current.start;
        if ((edge - position) * direction > 2) {
          const target =
            direction > 0
              ? Math.min(edge, position + amount)
              : Math.max(edge, position - amount);
          if (smooth) glideTo(target, SETTLE_MS);
          else scroller.scrollTop = target;
          return "inside";
        }
      }
      // The next slide in this direction, whether we are at rest on a slide or between two.
      const next =
        direction > 0
          ? list.find((slide) => slide.start > position + 2)
          : list.filter((slide) => slide.end < position - 2).at(-1);
      if (next) glideTo(direction > 0 ? next.start : next.end);
      return "page";
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      const delta = event.deltaY * unit;
      const magnitude = Math.abs(delta);
      const quiet = now - lastWheel > 160;
      const average =
        recentDeltas.reduce((sum, value) => sum + value, 0) /
        Math.max(1, recentDeltas.length);
      // Momentum only decays, so a delta well above the recent average is a new swipe.
      const surge =
        recentDeltas.length > 0 && magnitude > 20 && magnitude > average * 1.6;
      lastWheel = now;
      recentDeltas.push(magnitude);
      if (recentDeltas.length > 6) recentDeltas.shift();

      if (animating) return;
      if (quiet || surge) {
        locked = false;
        accumulated = 0;
      }
      if (locked) return;
      accumulated += delta;
      if (Math.abs(accumulated) < 8) return;
      const direction = accumulated > 0 ? 1 : -1;
      if (advance(direction, Math.abs(accumulated), false) === "inside") {
        accumulated = 0;
        return;
      }
      locked = true;
      accumulated = 0;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!scroller.getClientRects().length) return; // chat tab hidden
      // Only when nothing else owns the keyboard: focus is on the page body or the landing itself.
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      if (event.key === " " && active?.closest("button, a, [role=button]")) return;

      const page = scroller.clientHeight * 0.85;
      const down =
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        (event.key === " " && !event.shiftKey);
      const up =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        (event.key === " " && event.shiftKey);
      if (down) advance(1, page, true);
      else if (up) advance(-1, page, true);
      else if (event.key === "Home") glideTo(slides()[0]?.start ?? 0);
      else if (event.key === "End") glideTo(slides().at(-1)?.end ?? scroller.scrollTop);
      else return;
      event.preventDefault();
    };

    // Anything that leaves the page between slides (scrollbar, focus, find-in-page, resize) settles.
    const settle = (duration = SETTLE_MS) => {
      if (animating || draggingScrollbar) return;
      const list = slides();
      const position = scroller.scrollTop;
      if (list.some((slide) => position >= slide.start - 1 && position <= slide.end + 1)) {
        return;
      }
      let target = position;
      let best = Infinity;
      for (const slide of list) {
        const edge = position < slide.start ? slide.start : slide.end;
        if (Math.abs(edge - position) < best) {
          best = Math.abs(edge - position);
          target = edge;
        }
      }
      glideTo(target, duration);
    };

    const onScroll = () => {
      if (animating) return;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => settle(), 160);
    };

    const onPointerDown = (event: PointerEvent) => {
      // Presses right of the content box land on the scrollbar.
      const rect = scroller.getBoundingClientRect();
      if (event.clientX - rect.left >= scroller.clientWidth) draggingScrollbar = true;
    };
    const onPointerUp = () => {
      if (!draggingScrollbar) return;
      draggingScrollbar = false;
      settle();
    };

    const resizeObserver = new ResizeObserver(() => settle(0));
    resizeObserver.observe(scroller);
    resizeObserver.observe(root);

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(animation);
      window.clearTimeout(settleTimer);
      resizeObserver.disconnect();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      scroller.style.scrollBehavior = previousBehavior;
    };
  }, [rootRef]);
}

// Fades and lifts `[data-reveal]` children into place, and starts `[data-lit]` paragraphs lighting
// word by word, the first time they enter the scroller.
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
    for (const element of root.querySelectorAll("[data-reveal], [data-lit]"))
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

// Words light up in reading order once the paragraph is shown (see `.landing-lit` in globals.css).
function LitParagraph({
  text,
  delay = 0,
  className,
}: {
  text: string;
  delay?: number;
  className?: string;
}) {
  const words = text.split(" ");
  return (
    <p
      data-lit=""
      className={cn("landing-lit", className)}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
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
        "relative mx-auto flex min-h-[var(--landing-vh)] w-full max-w-page flex-col justify-center px-6 py-16 sm:px-10 lg:px-16",
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

// Dala-style landing: one fixed 3D constellation behind a column of sections. Scrolling morphs
// it brain → dust → contract stack → risk skyline → routing network → SignLoop mark; the pointer
// tilts it, dragging spins it, and clicks send a shockwave through it.
// `backdrop` is a layer behind the whole chat panel (slides and composer). The constellation renders
// there rather than inside the scroller, so it isn't clipped at the composer's top edge.
export function LandingHero({ backdrop }: { backdrop: HTMLElement | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isHeroTitleComplete, setIsHeroTitleComplete] = useState(false);
  const { stageRef, viewportHeight } = useScrollStage(rootRef);
  useSlideSnap(rootRef);
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
      {backdrop &&
        createPortal(
          <Constellation stageRef={stageRef} interactionRef={rootRef} />,
          backdrop,
        )}

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
            {manifesto.map((paragraph, index) => (
              <LitParagraph
                key={paragraph}
                text={paragraph}
                delay={index * 900}
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
