"use client";

import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

// Dala's signature imagery (DESIGN.md "Hero Constellation Visualization"), taken into 3D: one cloud
// of tiny outlined triangles that morphs between shapes as the landing page scrolls — brain, loose
// dust, a contract stack, a risk skyline, a routing network, and finally the SignLoop mark.
// Canvas-drawn and batched per colour/depth bucket so a frame is ~24 strokes, not one per particle.

const PALETTE = [
  { color: "#8052ff", weight: 0.32 }, // 0 Electric Iris
  { color: "#a98bff", weight: 0.12 }, // 1 Iris, lifted
  { color: "#4d7cff", weight: 0.16 }, // 2 blue
  { color: "#d15cff", weight: 0.12 }, // 3 magenta
  { color: "#1fae90", weight: 0.14 }, // 4 Deep Verdant, lifted to read on the void
  { color: "#ffb829", weight: 0.14 }, // 5 Saffron Spark
] as const;

// Same hues, deepened so thin 1px strokes hold up on the light theme's paper-white canvas.
const LIGHT_COLORS = ["#6a3cf0", "#8566f2", "#3563e0", "#b53ae0", "#12806a", "#d48c00"] as const;

const IRIS = 0;
const IRIS_LIFT = 1;
const BLUE = 2;
const MAGENTA = 3;
const VERDANT = 4;
const SAFFRON = 5;

const DEPTH_BUCKETS = 4;
const TAU = Math.PI * 2;
const CAMERA = 3.4;

/** Shapes in scroll order; `stageRef` indexes into this list (fractional values morph). */
export const CONSTELLATION_STAGES = ["brain", "dust", "document", "skyline", "network", "mark"] as const;

type Vec3 = [number, number, number];

type Shape = {
  positions: Float32Array;
  colors: Uint8Array;
  // Particles with `flow` set travel along a segment over time instead of holding still.
  flow?: { from: Float32Array; to: Float32Array; offset: Float32Array; on: Uint8Array };
};

// Where each stage sits on screen and how it is posed. `x` is a fraction of the canvas width.
type Pose = { x: number; scale: number; alpha: number; yaw: number; pitch: number; sway: number };

const DESKTOP_POSES: Pose[] = [
  { x: 0.73, scale: 1, alpha: 1, yaw: -0.25, pitch: 0.1, sway: 0.3 },
  { x: 0.5, scale: 1.05, alpha: 0.75, yaw: 0.4, pitch: 0.1, sway: 0.25 },
  { x: 0.72, scale: 0.95, alpha: 1, yaw: -0.45, pitch: 0.12, sway: 0.3 },
  { x: 0.26, scale: 0.74, alpha: 1, yaw: 0.3, pitch: 0.28, sway: 0.2 },
  { x: 0.72, scale: 0.95, alpha: 1, yaw: 0.2, pitch: 0.25, sway: 0.9 },
  { x: 0.5, scale: 0.85, alpha: 0.6, yaw: 0, pitch: 0.08, sway: 0.45 },
];

const MOBILE_ALPHA = 0.35;

// Seeded so every shape is identical across resizes and remounts.
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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

class ShapeWriter {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  index = 0;

  constructor(readonly count: number) {
    this.positions = new Float32Array(count * 3);
    this.colors = new Uint8Array(count);
  }

  get full() {
    return this.index >= this.count;
  }

  push(x: number, y: number, z: number, color: number) {
    if (this.full) return;
    this.positions.set([x, y, z], this.index * 3);
    this.colors[this.index] = color;
    this.index += 1;
  }
}

// Ambient dust shared by every shape, so a few particles always drift around the scene.
function dustPoint(random: () => number): Vec3 {
  return [random() * 5.2 - 2.6, random() * 3.2 - 1.6, random() * 2.4 - 1.2];
}

// Brain in normalised units (x front → back, y down, z left → right), modelled like an atlas
// illustration so it reads as a brain at a glance: a domed cerebrum over a flatter base, a
// temporal lobe hanging below the Sylvian fissure, a striped cerebellum tucked under the back,
// and the stem. Each region carries its own colour; gyri are sampled as ridges with dark sulci.
type BrainRegion = "frontal" | "parietal" | "occipital" | "temporal" | "cerebellum" | "stem";

const BRAIN_PARTS = [
  { region: "cerebrum", c: [-0.02, -0.14, 0.22], r: [1, 0.62, 0.42] },
  { region: "cerebrum", c: [-0.02, -0.14, -0.22], r: [1, 0.62, 0.42] },
  { region: "cerebrum", c: [-0.52, 0.06, 0.24], r: [0.46, 0.38, 0.32] },
  { region: "cerebrum", c: [-0.52, 0.06, -0.24], r: [0.46, 0.38, 0.32] },
  { region: "cerebrum", c: [0.66, -0.04, 0.2], r: [0.36, 0.4, 0.32] },
  { region: "cerebrum", c: [0.66, -0.04, -0.2], r: [0.36, 0.4, 0.32] },
  { region: "temporal", c: [-0.06, 0.28, 0.3], r: [0.62, 0.27, 0.26] },
  { region: "temporal", c: [-0.06, 0.28, -0.3], r: [0.62, 0.27, 0.26] },
  { region: "cerebellum", c: [0.56, 0.5, 0], r: [0.34, 0.19, 0.42] },
  { region: "stem", c: [0.2, 0.66, 0], r: [0.14, 0.32, 0.15] },
] as const;

const REGION_COLORS: Record<BrainRegion, [number, number]> = {
  frontal: [IRIS, IRIS_LIFT],
  parietal: [BLUE, IRIS],
  occipital: [MAGENTA, IRIS],
  temporal: [SAFFRON, SAFFRON],
  cerebellum: [VERDANT, VERDANT],
  stem: [IRIS_LIFT, BLUE],
};

// Sylvian fissure: the groove rising from the front of the temporal lobe toward the back.
const sylvianY = (x: number) => 0.2 - 0.2 * (x + 0.6);

function brainSample(x: number, y: number, z: number) {
  let best = Infinity;
  let part: (typeof BRAIN_PARTS)[number] = BRAIN_PARTS[0];
  for (const candidate of BRAIN_PARTS) {
    const { c, r } = candidate;
    const dx = (x - c[0]) / r[0];
    const dy = (y - c[1]) / r[1];
    const dz = (z - c[2]) / r[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < best) {
      best = distance;
      part = candidate;
    }
  }
  let region: BrainRegion;
  if (part.region === "cerebrum") region = x < -0.28 ? "frontal" : x < 0.42 ? "parietal" : "occipital";
  else region = part.region;
  return { distance: best, region };
}

function buildBrain(count: number, baseColors: Uint8Array, ambient: Uint8Array, dust: Float32Array): Shape {
  const random = mulberry32(0x5167_1009);
  const shape = new ShapeWriter(count);
  let cloudCount = 0;
  for (let i = 0; i < count; i += 1) if (!ambient[i]) cloudCount += 1;

  const points: [number, number, number, number][] = [];
  let guard = 0;
  while (points.length < cloudCount && guard < count * 600) {
    guard += 1;
    const x = random() * 2.3 - 1.15;
    const y = random() * 1.9 - 0.8;
    const z = random() * 1.4 - 0.7;
    const { distance, region } = brainSample(x, y, z);
    if (distance > 1) continue;
    const shell = distance > 0.82;
    // A faint core keeps the volume from looking hollow when it turns.
    if (!shell && region !== "stem" && random() > 0.025) continue;

    const cortex = region === "frontal" || region === "parietal" || region === "occipital";
    if (cortex) {
      if (Math.abs(z) < 0.06 && y < 0.15) continue; // longitudinal fissure between hemispheres
      if (y > sylvianY(x) - 0.02 && x < 0.45) continue; // cortex stays above the Sylvian fissure
      if (x > 0.3 && y > 0.3) continue; // leave a gap above the cerebellum
    }
    if (region === "temporal" && (y < sylvianY(x) + 0.05 || x > 0.5)) continue;
    if (region === "cerebellum" && y < 0.37) continue;
    if (region === "stem" && y < 0.5) continue;

    if (shell && (cortex || region === "temporal")) {
      // Gyri: keep sinuous ridges, drop the sulci between them.
      const wave = Math.sin(x * 8 + 2.6 * Math.sin(y * 5 + z * 3) + 1.4 * Math.sin(z * 7 + x * 2));
      if (wave < -0.15) continue;
    }
    if (region === "cerebellum" && Math.sin(y * 48 + x * 6) < -0.1) continue; // folia stripes

    const [primary, secondary] = REGION_COLORS[region];
    const roll = random();
    const color = roll < 0.8 ? primary : roll < 0.93 ? secondary : IRIS_LIFT;
    points.push([x, y, z, color]);
  }

  let cloud = 0;
  for (let i = 0; i < count; i += 1) {
    const color = baseColors[i] ?? 0;
    if (ambient[i] || cloud >= points.length) {
      shape.push(dust[i * 3]!, dust[i * 3 + 1]!, dust[i * 3 + 2]!, color);
    } else {
      const [x, y, z, pointColor] = points[cloud]!;
      cloud += 1;
      shape.push(x, y, z, pointColor);
    }
  }
  return { positions: shape.positions, colors: shape.colors };
}

function buildDust(count: number, baseColors: Uint8Array): Shape {
  const random = mulberry32(0xd057);
  const shape = new ShapeWriter(count);
  for (let i = 0; i < count; i += 1) {
    const [x, y, z] = dustPoint(random);
    shape.push(x, y, z, baseColors[i] ?? 0);
  }
  return shape;
}

// Three fanned contract pages. The front page carries "lines of text" and one flagged clause.
function buildDocument(count: number, ambient: Uint8Array, dust: Float32Array, baseColors: Uint8Array): Shape {
  const random = mulberry32(0xd0c5);
  const width = 1.12;
  const height = 1.52;
  const pages = [
    { dx: -0.26, dy: 0.18, dz: -0.46, share: 0.14 },
    { dx: -0.13, dy: 0.09, dz: -0.23, share: 0.18 },
    { dx: 0, dy: 0, dz: 0, share: 0.68 },
  ];
  // Paragraph layout for the front page: line lengths, with a flagged clause in the middle.
  const lines: { y: number; length: number; flagged: boolean; heading: boolean }[] = [];
  let y = -0.6;
  let paragraph = 0;
  while (y < 0.64) {
    const heading = paragraph === 0 && lines.length === 0;
    const breakHere = random() < 0.18 && lines.length > 1;
    if (breakHere) {
      y += 0.06;
      paragraph += 1;
    }
    lines.push({
      y,
      length: heading ? 0.45 : breakHere ? 0.55 + random() * 0.3 : 0.75 + random() * 0.25,
      flagged: paragraph === 3,
      heading,
    });
    y += heading ? 0.12 : 0.072;
  }

  const cloudIndices: number[] = [];
  for (let i = 0; i < count; i += 1) if (!ambient[i]) cloudIndices.push(i);
  const total = cloudIndices.length;
  let written = 0;
  const colors = new Uint8Array(count);
  const positions = new Float32Array(count * 3);
  const put = (x: number, py: number, z: number, color: number) => {
    const target = cloudIndices[written];
    if (target === undefined) return;
    positions.set([x, py, z], target * 3);
    colors[target] = color;
    written += 1;
  };

  for (const [pageIndex, page] of pages.entries()) {
    const budget = Math.round(total * page.share);
    const front = pageIndex === pages.length - 1;
    const outline = front ? Math.round(budget * 0.3) : Math.round(budget * 0.7);
    for (let i = 0; i < outline; i += 1) {
      const t = random() * (2 * (width + height));
      let px: number;
      let py: number;
      if (t < width) [px, py] = [t - width / 2, -height / 2];
      else if (t < width + height) [px, py] = [width / 2, t - width - height / 2];
      else if (t < 2 * width + height) [px, py] = [width / 2 - (t - width - height), height / 2];
      else [px, py] = [-width / 2, height / 2 - (t - 2 * width - height)];
      put(px + page.dx, py + page.dy, page.dz, front ? IRIS_LIFT : BLUE);
    }
    const textBudget = budget - outline;
    for (let i = 0; i < textBudget; i += 1) {
      const line = lines[Math.floor(random() * lines.length)]!;
      const inner = width * 0.78;
      const px = -inner / 2 + random() * inner * line.length;
      // Word gaps: skip particles that land in a gap and resample once along the line.
      const word = Math.sin(px * 38 + line.y * 17) > 0.82 ? px + 0.03 : px;
      const color = !front ? IRIS : line.flagged ? SAFFRON : line.heading ? IRIS_LIFT : random() < 0.7 ? IRIS : BLUE;
      put(word + page.dx, line.y + (random() - 0.5) * 0.018 + page.dy, page.dz + (random() - 0.5) * 0.02, color);
    }
  }
  // Rounding leftovers join the front page's text.
  while (written < total) put((random() - 0.5) * 0.8, (random() - 0.5) * 1.2, 0, IRIS);

  for (let i = 0; i < count; i += 1) {
    if (!ambient[i]) continue;
    positions.set([dust[i * 3]!, dust[i * 3 + 1]!, dust[i * 3 + 2]!], i * 3);
    colors[i] = baseColors[i] ?? 0;
  }
  return { positions, colors };
}

// A grouped 3D bar chart: three rows of six clause bars whose heights climb left → right and are
// coloured by risk (verdant → saffron → magenta). Bars are crisp wireframe boxes with lit lids,
// standing on floor axes so the whole thing reads as a chart, not a skyline.
function buildSkyline(count: number, ambient: Uint8Array, dust: Float32Array, baseColors: Uint8Array): Shape {
  const random = mulberry32(0x5c1e);
  const columnsX = 6;
  const rows = 3;
  const spacingX = 0.34;
  const spacingZ = 0.46;
  const size = 0.2;
  const floor = 0.62;
  const half = size / 2;
  // Row heights (low → high risk), each row offset so the rows stay distinct from any angle.
  const heights = [
    [0.12, 0.2, 0.3, 0.46, 0.66, 0.92],
    [0.16, 0.26, 0.4, 0.58, 0.84, 1.14],
    [0.1, 0.16, 0.24, 0.36, 0.52, 0.74],
  ];

  type Segment = { a: Vec3; b: Vec3; color: number; length: number };
  const segments: Segment[] = [];
  const lids: { x: number; z: number; top: number; color: number }[] = [];
  const addSegment = (a: Vec3, b: Vec3, color: number, weight = 1) => {
    segments.push({ a, b, color, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * weight });
  };

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columnsX; column += 1) {
      const cx = (column - (columnsX - 1) / 2) * spacingX;
      const cz = (row - (rows - 1) / 2) * spacingZ;
      const h = heights[row]![column]!;
      const top = floor - h;
      const color = h > 0.7 ? MAGENTA : h > 0.34 ? SAFFRON : VERDANT;
      const corners: [number, number][] = [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ];
      for (const [index, [dx, dz]] of corners.entries()) {
        const [nx, nz] = corners[(index + 1) % corners.length]!;
        addSegment([cx + dx, floor, cz + dz], [cx + dx, top, cz + dz], color); // vertical edge
        addSegment([cx + dx, top, cz + dz], [cx + nx, top, cz + nz], color, 1.6); // lid outline
        addSegment([cx + dx, floor, cz + dz], [cx + nx, floor, cz + nz], color, 0.6); // footprint
      }
      lids.push({ x: cx, z: cz, top, color });
    }
  }

  // Chart axes along the floor's front and left edges, plus a vertical value axis.
  const left = -((columnsX - 1) / 2) * spacingX - 0.2;
  const right = ((columnsX - 1) / 2) * spacingX + 0.2;
  const front = ((rows - 1) / 2) * spacingZ + 0.26;
  const back = -((rows - 1) / 2) * spacingZ - 0.26;
  addSegment([left, floor, front], [right, floor, front], IRIS_LIFT, 1.4);
  addSegment([left, floor, front], [left, floor, back], IRIS_LIFT, 1.4);
  addSegment([left, floor, back], [left, floor - 1.2, back], IRIS_LIFT, 1.4);
  for (let tick = 1; tick <= 4; tick += 1) {
    const y = floor - tick * 0.28;
    addSegment([left, y, back], [left + 0.08, y, back], IRIS_LIFT, 1.5);
  }

  const lengthTotal = segments.reduce((sum, segment) => sum + segment.length, 0);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    if (ambient[i]) {
      positions.set([dust[i * 3]!, dust[i * 3 + 1]!, dust[i * 3 + 2]!], i * 3);
      colors[i] = baseColors[i] ?? 0;
      continue;
    }
    // 14% fill the lids so each bar's top reads as a solid cap.
    if (random() < 0.14) {
      const lid = lids[Math.floor(random() * lids.length)]!;
      positions.set([lid.x + (random() - 0.5) * size, lid.top, lid.z + (random() - 0.5) * size], i * 3);
      colors[i] = lid.color;
      continue;
    }
    let roll = random() * lengthTotal;
    let segment = segments[0]!;
    for (const candidate of segments) {
      roll -= candidate.length;
      if (roll <= 0) {
        segment = candidate;
        break;
      }
    }
    const t = random();
    positions.set(
      [
        lerp(segment.a[0], segment.b[0], t),
        lerp(segment.a[1], segment.b[1], t),
        lerp(segment.a[2], segment.b[2], t),
      ],
      i * 3,
    );
    colors[i] = segment.color;
  }
  return { positions, colors };
}

function spherePoint(random: () => number, radius: number): Vec3 {
  const u = random() * 2 - 1;
  const theta = random() * TAU;
  const r = radius * (0.85 + random() * 0.15);
  const s = Math.sqrt(1 - u * u);
  return [r * s * Math.cos(theta), r * u, r * s * Math.sin(theta)];
}

// A routing hub linked to six model nodes; edge particles stream outward along the links.
function buildNetwork(count: number, ambient: Uint8Array, dust: Float32Array, baseColors: Uint8Array): Shape {
  const random = mulberry32(0x2e7);
  const nodeColors = [BLUE, VERDANT, SAFFRON, MAGENTA, IRIS_LIFT, VERDANT];
  const nodes: Vec3[] = nodeColors.map((_, index) => {
    const angle = (index / nodeColors.length) * TAU + 0.3;
    return [Math.cos(angle) * 1.05, Math.sin(angle * 2) * 0.28 + (index % 2 ? 0.22 : -0.22), Math.sin(angle) * 0.75];
  });
  const edges: [Vec3, Vec3, number][] = nodes.map((node, index) => [[0, 0, 0], node, nodeColors[index]!]);
  for (let index = 0; index < nodes.length; index += 2) {
    edges.push([nodes[index]!, nodes[(index + 1) % nodes.length]!, IRIS]);
  }

  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count);
  const from = new Float32Array(count * 3);
  const to = new Float32Array(count * 3);
  const offset = new Float32Array(count);
  const on = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    if (ambient[i]) {
      positions.set([dust[i * 3]!, dust[i * 3 + 1]!, dust[i * 3 + 2]!], i * 3);
      colors[i] = baseColors[i] ?? 0;
      continue;
    }
    const roll = random();
    if (roll < 0.26) {
      positions.set(spherePoint(random, 0.3), i * 3);
      colors[i] = random() < 0.75 ? IRIS : IRIS_LIFT;
    } else if (roll < 0.6) {
      const node = Math.floor(random() * nodes.length);
      const [nx, ny, nz] = nodes[node]!;
      const [sx, sy, sz] = spherePoint(random, 0.13 + (node % 3) * 0.025);
      positions.set([nx + sx, ny + sy, nz + sz], i * 3);
      colors[i] = nodeColors[node]!;
    } else {
      const [a, b, color] = edges[Math.floor(random() * edges.length)]!;
      const jitter = () => (random() - 0.5) * 0.03;
      from.set([a[0] + jitter(), a[1] + jitter(), a[2] + jitter()], i * 3);
      to.set([b[0] + jitter(), b[1] + jitter(), b[2] + jitter()], i * 3);
      offset[i] = random();
      on[i] = 1;
      colors[i] = color;
      positions.set(a, i * 3);
    }
  }
  return { positions, colors, flow: { from, to, offset, on } };
}

// The SignLoop arrow mark (app/icon.svg), extruded, with the iris → verdant gradient.
const MARK: [number, number][] = [
  [10, 1.5],
  [18.5, 18.5],
  [10, 13.4],
  [1.5, 18.5],
];

function insideMark(x: number, y: number) {
  let inside = false;
  for (let i = 0, j = MARK.length - 1; i < MARK.length; j = i, i += 1) {
    const [xi, yi] = MARK[i]!;
    const [xj, yj] = MARK[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildMark(count: number, ambient: Uint8Array, dust: Float32Array, baseColors: Uint8Array): Shape {
  const random = mulberry32(0x4a2c);
  const toUnit = (value: number) => (value - 10) / 7.6;
  const depth = 0.16;
  const perimeter = MARK.map((point, index) => {
    const next = MARK[(index + 1) % MARK.length]!;
    return { a: point, b: next, length: Math.hypot(next[0] - point[0], next[1] - point[1]) };
  });
  const perimeterTotal = perimeter.reduce((sum, edge) => sum + edge.length, 0);
  const gradient = (x: number, y: number) => {
    const t = clamp01(((x + y) / 20 - 0.35) / 0.65);
    return t < 0.3 ? IRIS : t < 0.55 ? IRIS_LIFT : t < 0.75 ? BLUE : VERDANT;
  };

  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    if (ambient[i]) {
      positions.set([dust[i * 3]!, dust[i * 3 + 1]!, dust[i * 3 + 2]!], i * 3);
      colors[i] = baseColors[i] ?? 0;
      continue;
    }
    let sx: number;
    let sy: number;
    let z: number;
    if (random() < 0.42) {
      // Edges and side walls.
      let roll = random() * perimeterTotal;
      let edge = perimeter[0]!;
      for (const candidate of perimeter) {
        roll -= candidate.length;
        if (roll <= 0) {
          edge = candidate;
          break;
        }
      }
      const t = random();
      sx = lerp(edge.a[0], edge.b[0], t);
      sy = lerp(edge.a[1], edge.b[1], t);
      z = random() < 0.6 ? (random() < 0.5 ? -depth : depth) : (random() * 2 - 1) * depth;
    } else {
      do {
        sx = 1.5 + random() * 17;
        sy = 1.5 + random() * 17;
      } while (!insideMark(sx, sy));
      z = random() < 0.5 ? -depth : depth;
    }
    positions.set([toUnit(sx), toUnit(sy) + 0.05, z], i * 3);
    colors[i] = gradient(sx, sy);
  }
  return { positions, colors };
}

type Field = {
  count: number;
  shapes: Shape[];
  scatter: Float32Array; // per-particle unit vector for the mid-morph bloom
  delay: Float32Array; // per-particle morph stagger, 0..1
  size: Float32Array;
  rotation: Float32Array;
  spin: Float32Array;
  phase: Float32Array;
  // Screen-space kinetic offset (px) and velocity, sprung back to rest.
  offset: Float32Array;
  velocity: Float32Array;
};

function createField(count: number): Field {
  const random = mulberry32(0x516e);
  const baseColors = new Uint8Array(count);
  const ambient = new Uint8Array(count);
  const dust = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const delay = new Float32Array(count);
  const size = new Float32Array(count);
  const rotation = new Float32Array(count);
  const spin = new Float32Array(count);
  const phase = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    baseColors[i] = pickColor(random);
    ambient[i] = random() < 0.1 ? 1 : 0;
    dust.set(dustPoint(random), i * 3);
    scatter.set(spherePoint(random, 1), i * 3);
    size[i] = 1.6 + random() * 2.6;
    rotation[i] = random() * TAU;
    spin[i] = (random() - 0.5) * 0.0008;
    phase[i] = random() * TAU;
  }

  const shapes = [
    buildBrain(count, baseColors, ambient, dust),
    buildDust(count, baseColors),
    buildDocument(count, ambient, dust, baseColors),
    buildSkyline(count, ambient, dust, baseColors),
    buildNetwork(count, ambient, dust, baseColors),
    buildMark(count, ambient, dust, baseColors),
  ];

  // Morphs sweep left → right with noise, so shapes dissolve and re-form rather than cross-fade.
  const brain = shapes[0]!.positions;
  for (let i = 0; i < count; i += 1) delay[i] = 0.55 * random() + 0.45 * clamp01((brain[i * 3]! + 1.2) / 2.4);

  return {
    count,
    shapes,
    scatter,
    delay,
    size,
    rotation,
    spin,
    phase,
    offset: new Float32Array(count * 2),
    velocity: new Float32Array(count * 2),
  };
}

function shapePoint(shape: Shape, i: number, time: number, out: Vec3) {
  const flow = shape.flow;
  if (flow?.on[i]) {
    const t = (flow.offset[i]! + time * 0.00009) % 1;
    out[0] = lerp(flow.from[i * 3]!, flow.to[i * 3]!, t);
    out[1] = lerp(flow.from[i * 3 + 1]!, flow.to[i * 3 + 1]!, t);
    out[2] = lerp(flow.from[i * 3 + 2]!, flow.to[i * 3 + 2]!, t);
    return;
  }
  out[0] = shape.positions[i * 3]!;
  out[1] = shape.positions[i * 3 + 1]!;
  out[2] = shape.positions[i * 3 + 2]!;
}

type ConstellationProps = {
  className?: string;
  /** Scroll stage, 0..CONSTELLATION_STAGES.length-1. Omit for the static brain. */
  stageRef?: RefObject<number>;
  /** Element that receives drag-to-spin and click shockwaves. Pointer tilt always follows the window. */
  interactionRef?: RefObject<HTMLElement | null>;
};

const NON_DRAG_TARGETS = "a,button,input,textarea,select,label,[role=button],h1,h2,h3,p,dt,dd,li";

export function Constellation({ className, stageRef, interactionRef }: ConstellationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let field: Field | null = null;
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    let lastTime = 0;
    let stage = stageRef?.current ?? 0;

    // Pointer state in canvas pixels; tilt is smoothed toward the pointer's normalised position.
    const pointer = { x: -9999, y: -9999, active: false, tiltX: 0, tiltY: 0 };
    const drag = { active: false, moved: false, lastX: 0, yaw: 0, velocity: 0 };
    const waves: { x: number; y: number; start: number }[] = [];
    const point: Vec3 = [0, 0, 0];
    const next: Vec3 = [0, 0, 0];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round(Math.min(2600, Math.max(900, (width * height) / 380)));
      if (!field || Math.abs(count - field.count) > 200) field = createField(count);
    };

    const pose = (index: number): Pose => {
      const desktop = DESKTOP_POSES[Math.min(DESKTOP_POSES.length - 1, Math.max(0, index))]!;
      if (width >= 1024) return desktop;
      return { ...desktop, x: 0.5, alpha: MOBILE_ALPHA * (index === 1 ? 1.4 : 1) };
    };

    const draw = (time: number) => {
      if (!field) return;
      const motion = !reducedMotion.matches;
      const dt = Math.min(64, lastTime ? time - lastTime : 16);
      lastTime = time;
      const light = document.documentElement.classList.contains("light");

      // Ease the stage toward the scroll position; reduced motion snaps between whole shapes.
      const target = stageRef?.current ?? 0;
      stage = motion ? stage + (target - stage) * (1 - Math.exp(-dt / 140)) : Math.round(target);
      if (Math.abs(target - stage) < 0.0005) stage = target;
      const fromIndex = Math.min(field.shapes.length - 1, Math.floor(stage));
      const toIndex = Math.min(field.shapes.length - 1, fromIndex + 1);
      const progress = stage - fromIndex;
      const from = field.shapes[fromIndex]!;
      const to = field.shapes[toIndex]!;
      const a = pose(fromIndex);
      const b = pose(toIndex);
      const posed = easeInOutCubic(progress);

      // Pointer tilt and drag spin (with inertia) layer over each shape's resting pose.
      const nx = pointer.active ? (pointer.x / width) * 2 - 1 : 0;
      const ny = pointer.active ? (pointer.y / height) * 2 - 1 : 0;
      pointer.tiltX += (nx - pointer.tiltX) * (1 - Math.exp(-dt / 400));
      pointer.tiltY += (ny - pointer.tiltY) * (1 - Math.exp(-dt / 400));
      if (!drag.active) {
        drag.yaw += drag.velocity * dt;
        drag.velocity *= Math.exp(-dt / 900);
      }
      const clock = motion ? time : 0;
      const sway = lerp(a.sway, b.sway, posed);
      const yaw =
        lerp(a.yaw, b.yaw, posed) + Math.sin(clock * 0.00012) * sway + pointer.tiltX * 0.45 + drag.yaw;
      const pitch = lerp(a.pitch, b.pitch, posed) + Math.sin(clock * 0.00009) * 0.06 + pointer.tiltY * 0.22;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);

      const unit = Math.min(width >= 1024 ? width * 0.21 : width * 0.38, height * 0.36) * lerp(a.scale, b.scale, posed);
      const originX = width * lerp(a.x, b.x, posed);
      const originY = height * 0.5;
      const alphaScale = lerp(a.alpha, b.alpha, posed) * (light ? 1.35 : 1);

      const buckets = PALETTE.map(({ color }, index) =>
        Array.from({ length: DEPTH_BUCKETS }, (_, depth) => ({
          color: light ? LIGHT_COLORS[index]! : color,
          alpha: Math.min(1, (0.3 + depth * 0.22) * alphaScale),
          path: new Path2D(),
        })),
      );

      const now = performance.now();
      while (waves.length && now - waves[0]!.start > 1400) waves.shift();
      const spring = 1 - Math.exp(-dt / 260);
      const damping = Math.exp(-dt / 110);
      const repelRadius = 110;

      for (let i = 0; i < field.count; i += 1) {
        const local: number = motion ? easeInOutCubic(clamp01((progress - field.delay[i]! * 0.4) / 0.6)) : progress;
        shapePoint(from, i, clock, point);
        let x = point[0];
        let y = point[1];
        let z = point[2];
        if (local > 0) {
          shapePoint(to, i, clock, next);
          const bloom = Math.sin(local * Math.PI) * 0.45;
          x = lerp(x, next[0], local) + field.scatter[i * 3]! * bloom;
          y = lerp(y, next[1], local) + field.scatter[i * 3 + 1]! * bloom;
          z = lerp(z, next[2], local) + field.scatter[i * 3 + 2]! * bloom;
        }
        const drift = motion ? Math.sin(clock * 0.0006 + field.phase[i]!) * 0.012 : 0;
        x += drift;
        y += drift * 0.6;

        const rx = x * cosYaw + z * sinYaw;
        const rz0 = -x * sinYaw + z * cosYaw;
        const ry = y * cosPitch - rz0 * sinPitch;
        const rz = y * sinPitch + rz0 * cosPitch;
        const perspective = CAMERA / (CAMERA - rz);
        if (perspective <= 0 || perspective > 6) continue;

        let px = originX + rx * unit * perspective;
        let py = originY + ry * unit * perspective;

        // Kinetic layer: cursor repulsion and click shockwaves push particles, springs pull back.
        if (motion) {
          let vx = field.velocity[i * 2]!;
          let vy = field.velocity[i * 2 + 1]!;
          const ox = field.offset[i * 2]!;
          const oy = field.offset[i * 2 + 1]!;
          if (pointer.active) {
            const dx = px + ox - pointer.x;
            const dy = py + oy - pointer.y;
            const distance = Math.hypot(dx, dy);
            if (distance < repelRadius && distance > 0.01) {
              const force = (1 - distance / repelRadius) ** 2 * 0.09 * dt;
              vx += (dx / distance) * force;
              vy += (dy / distance) * force;
            }
          }
          for (const wave of waves) {
            const age = now - wave.start;
            const dx = px - wave.x;
            const dy = py - wave.y;
            const distance = Math.hypot(dx, dy) || 1;
            const ring = age * 0.75;
            const band = Math.abs(distance - ring);
            if (band < 40) {
              const force = (1 - band / 40) * (1 - age / 1400) * 0.12 * dt;
              vx += (dx / distance) * force;
              vy += (dy / distance) * force;
            }
          }
          vx = (vx - ox * spring) * damping;
          vy = (vy - oy * spring) * damping;
          field.velocity[i * 2] = vx;
          field.velocity[i * 2 + 1] = vy;
          field.offset[i * 2] = ox + vx;
          field.offset[i * 2 + 1] = oy + vy;
          px += ox + vx;
          py += oy + vy;
        }

        if (px < -20 || px > width + 20 || py < -20 || py > height + 20) continue;

        const size = field.size[i]! * perspective;
        const angle = field.rotation[i]! + clock * field.spin[i]!;
        const color = (local > 0.5 ? to : from).colors[i] ?? 0;
        const depth = Math.min(DEPTH_BUCKETS - 1, Math.max(0, Math.floor(((rz + 1.1) / 2.2) * DEPTH_BUCKETS)));
        const path = buckets[color]?.[depth]?.path;
        if (!path) continue;
        path.moveTo(px + Math.cos(angle) * size, py + Math.sin(angle) * size);
        path.lineTo(px + Math.cos(angle + TAU / 3) * size, py + Math.sin(angle + TAU / 3) * size);
        path.lineTo(px + Math.cos(angle + (2 * TAU) / 3) * size, py + Math.sin(angle + (2 * TAU) / 3) * size);
        path.closePath();
      }

      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      context.lineJoin = "miter";
      for (const colorBuckets of buckets) {
        for (const bucket of colorBuckets) {
          context.globalAlpha = bucket.alpha;
          context.strokeStyle = bucket.color;
          context.stroke(bucket.path);
        }
      }
      context.globalAlpha = 1;
    };

    // Browsers already pause rAF in background tabs; `visible` stops it when scrolled away.
    const running = () => visible;

    const loop = (time: number) => {
      draw(time);
      frame = running() && !reducedMotion.matches ? requestAnimationFrame(loop) : 0;
    };

    // Reduced motion draws on demand (scroll, resize) instead of every frame.
    const requestDraw = () => {
      if (!frame && running()) frame = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      requestDraw();
    };

    resize();
    start();

    const resizeObserver = new ResizeObserver(() => {
      resize();
      requestDraw();
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      start();
    });
    intersectionObserver.observe(canvas);

    const toCanvas = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const { x, y } = toCanvas(event);
      pointer.x = x;
      pointer.y = y;
      pointer.active = x >= 0 && y >= 0 && x <= width && y <= height;
      if (drag.active) {
        const delta = event.clientX - drag.lastX;
        drag.lastX = event.clientX;
        if (Math.abs(delta) > 0) drag.moved = true;
        drag.yaw += delta * 0.006;
        drag.velocity = delta * 0.0004;
      }
      requestDraw();
    };

    const onPointerLeave = () => {
      pointer.active = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(NON_DRAG_TARGETS)) return;
      if (event.pointerType === "mouse" && event.button === 0) {
        drag.active = true;
        drag.moved = false;
        drag.lastX = event.clientX;
        drag.velocity = 0;
      } else if (event.pointerType !== "mouse") {
        const { x, y } = toCanvas(event);
        waves.push({ x, y, start: performance.now() });
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!drag.active) return;
      drag.active = false;
      if (!drag.moved) {
        const { x, y } = toCanvas(event);
        waves.push({ x, y, start: performance.now() });
      }
    };

    const interaction = interactionRef?.current;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    interaction?.addEventListener("pointerdown", onPointerDown);
    // The stage ref changes on scroll; reduced motion needs a nudge to redraw.
    const scroller = interaction ? findScrollParent(interaction) : null;
    scroller?.addEventListener("scroll", requestDraw, { passive: true });

    reducedMotion.addEventListener("change", start);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      interaction?.removeEventListener("pointerdown", onPointerDown);
      scroller?.removeEventListener("scroll", requestDraw);
      reducedMotion.removeEventListener("change", start);
    };
  }, [stageRef, interactionRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none block h-full w-full", className)}
    />
  );
}

/** Nearest ancestor that scrolls vertically; the landing page lives inside the chat viewport. */
export function findScrollParent(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}
