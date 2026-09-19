"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Dala's signature imagery (DESIGN.md "Hero Constellation Visualization"): thousands of tiny outlined
// triangles in vivid colours forming an organic brain-shaped cloud, plus sparse ambient particles.
// Canvas-drawn and batched per colour/depth bucket so a frame is ~24 strokes, not one per particle.

const PALETTE = [
  { color: "#8052ff", weight: 0.32 }, // Electric Iris
  { color: "#a98bff", weight: 0.12 }, // Iris, lifted
  { color: "#4d7cff", weight: 0.16 }, // blue
  { color: "#d15cff", weight: 0.12 }, // magenta
  { color: "#1fae90", weight: 0.14 }, // Deep Verdant, lifted to read on the void
  { color: "#ffb829", weight: 0.14 }, // Saffron Spark
] as const;

const DEPTH_BUCKETS = 4;
const TAU = Math.PI * 2;

type Particle = {
  x: number;
  y: number;
  z: number;
  size: number;
  rotation: number;
  spin: number;
  phase: number;
  color: number;
  ambient: boolean;
};

// Seeded so the shape is identical across resizes and remounts.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickColor(random: () => number): number {
  let roll = random();
  for (const [index, { weight }] of PALETTE.entries()) {
    roll -= weight;
    if (roll <= 0) return index;
  }
  return 0;
}

// Side-view brain in normalised units: cerebrum, cerebellum, and stem, with a wobbling outline.
const LOBES = [
  { cx: -0.05, cy: -0.08, rx: 1, ry: 0.7 },
  { cx: 0.58, cy: 0.5, rx: 0.34, ry: 0.22 },
  { cx: 0.22, cy: 0.72, rx: 0.11, ry: 0.26 },
] as const;

function lobeDistance(x: number, y: number, lobe: (typeof LOBES)[number]) {
  const dx = (x - lobe.cx) / lobe.rx;
  const dy = (y - lobe.cy) / lobe.ry;
  const angle = Math.atan2(dy, dx);
  const wobble = 1 + 0.06 * Math.sin(angle * 7 + 0.4) + 0.035 * Math.sin(angle * 13 + 1.7);
  return Math.hypot(dx, dy) / wobble;
}

function createParticles(count: number): Particle[] {
  const random = mulberry32(0x5167_1009);
  const particles: Particle[] = [];
  const ambientCount = Math.round(count * 0.12);
  let guard = 0;

  while (particles.length < count - ambientCount && guard < count * 60) {
    guard += 1;
    const x = random() * 2.2 - 1.1;
    const y = random() * 2 - 0.85;
    let inside = Infinity;
    for (const lobe of LOBES) inside = Math.min(inside, lobeDistance(x, y, lobe));
    if (inside > 1) continue;
    // Wavy density bands read as gyri; surface points are denser than the core.
    const folds = 0.5 + 0.5 * Math.sin(x * 9 + 4 * Math.sin(y * 6));
    if (random() > 0.35 + 0.65 * folds * (0.45 + 0.55 * inside)) continue;
    const depth = Math.sqrt(Math.max(0, 1 - inside * inside));
    particles.push({
      x,
      y,
      z: (random() * 2 - 1) * depth * 0.55,
      size: 1.6 + random() * 2.6,
      rotation: random() * TAU,
      spin: (random() - 0.5) * 0.0008,
      phase: random() * TAU,
      color: pickColor(random),
      ambient: false,
    });
  }

  for (let index = 0; index < ambientCount; index += 1) {
    particles.push({
      x: random() * 3.4 - 1.7,
      y: random() * 2.6 - 1.15,
      z: random() * 0.4 - 0.2,
      size: 1.4 + random() * 2,
      rotation: random() * TAU,
      spin: (random() - 0.5) * 0.0006,
      phase: random() * TAU,
      color: pickColor(random),
      ambient: true,
    });
  }

  return particles;
}

export function Constellation({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round(Math.min(1800, Math.max(500, (width * height) / 220)));
      if (count !== particles.length) particles = createParticles(count);
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width / 2.5, height / 2.05);
      const originX = width / 2;
      const originY = height / 2 - scale * 0.06;
      const sway = Math.sin(time * 0.00012) * 0.5;
      const cos = Math.cos(sway);
      const sin = Math.sin(sway);
      // Bucket 0 of each colour holds the ambient field; 1..n are depth slices of the cloud.
      const buckets = PALETTE.flatMap(({ color }) =>
        Array.from({ length: DEPTH_BUCKETS }, (_, depth) => ({
          color,
          alpha: depth === 0 ? 0.28 : 0.35 + depth * 0.2,
          path: new Path2D(),
        })),
      );

      for (const particle of particles) {
        const drift = Math.sin(time * 0.0006 + particle.phase) * 0.012;
        const rx = particle.ambient ? particle.x : particle.x * cos + particle.z * sin;
        const rz = particle.ambient ? particle.z : -particle.x * sin + particle.z * cos;
        const perspective = 1 / (1.6 - rz * 0.5);
        const px = originX + (rx + drift) * scale * perspective * 1.6;
        const py = originY + (particle.y + drift * 0.6) * scale * perspective * 1.6;
        const size = particle.size * perspective * 1.4;
        const angle = particle.rotation + time * particle.spin;
        const depth = particle.ambient
          ? 0
          : Math.min(DEPTH_BUCKETS - 1, Math.max(1, Math.floor(((rz + 0.55) / 1.1) * DEPTH_BUCKETS)));
        const path = buckets[particle.color * DEPTH_BUCKETS + depth]?.path;
        if (!path) continue;
        path.moveTo(px + Math.cos(angle) * size, py + Math.sin(angle) * size);
        path.lineTo(px + Math.cos(angle + TAU / 3) * size, py + Math.sin(angle + TAU / 3) * size);
        path.lineTo(px + Math.cos(angle + (2 * TAU) / 3) * size, py + Math.sin(angle + (2 * TAU) / 3) * size);
        path.closePath();
      }

      context.lineWidth = 1;
      context.lineJoin = "miter";
      for (const bucket of buckets) {
        context.globalAlpha = bucket.alpha;
        context.strokeStyle = bucket.color;
        context.stroke(bucket.path);
      }
      context.globalAlpha = 1;
    };

    const loop = (time: number) => {
      draw(time);
      frame = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
    };

    const start = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (reducedMotion.matches) {
        draw(0);
        return;
      }
      if (visible && !document.hidden) frame = requestAnimationFrame(loop);
    };

    resize();
    start();

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (!frame) draw(reducedMotion.matches ? 0 : performance.now());
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      start();
    });
    intersectionObserver.observe(canvas);

    document.addEventListener("visibilitychange", start);
    reducedMotion.addEventListener("change", start);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", start);
      reducedMotion.removeEventListener("change", start);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none block h-full w-full", className)}
    />
  );
}
