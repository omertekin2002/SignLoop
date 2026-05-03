"use client";

import { useId, useMemo, type CSSProperties, type SVGProps } from "react";
import { cn } from "@/lib/utils";

type AnimatedGridPatternProps = SVGProps<SVGSVGElement> & {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  strokeDasharray?: number;
  numSquares?: number;
  maxOpacity?: number;
  duration?: number;
  repeatDelay?: number;
};

function seededValue(seed: number): number {
  const x = Math.sin(seed * 999) * 10000;
  return x - Math.floor(x);
}

export function AnimatedGridPattern({
  width = 40,
  height = 40,
  x = -1,
  y = -1,
  strokeDasharray = 0,
  numSquares = 80,
  maxOpacity = 0.16,
  duration = 3,
  repeatDelay = 1,
  className,
  ...props
}: AnimatedGridPatternProps) {
  const id = useId();
  const squares = useMemo(() => {
    const columns = 24;
    const rows = 16;

    return Array.from({ length: numSquares }, (_, index) => {
      const column = Math.floor(seededValue(index + 1) * columns);
      const row = Math.floor(seededValue(index + 29) * rows);
      const delay = seededValue(index + 83) * (duration + repeatDelay);

      return {
        id: `${column}-${row}-${index}`,
        x: column * width + x,
        y: row * height + y,
        delay,
      };
    });
  }, [duration, height, numSquares, repeatDelay, width, x, y]);

  return (
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 w-full fill-slate-950/10 stroke-slate-950/10", className)}
      {...props}
    >
      <defs>
        <pattern
          id={id}
          width={width}
          height={height}
          x={x}
          y={y}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M.5 ${height}V.5H${width}`}
            fill="none"
            strokeDasharray={strokeDasharray}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
      <g>
        {squares.map((square) => (
          <rect
            key={square.id}
            x={square.x}
            y={square.y}
            width={width - 1}
            height={height - 1}
            className="signloop-grid-square"
            style={{
              animationDelay: `${square.delay}s`,
              animationDuration: `${duration + repeatDelay}s`,
              "--grid-square-opacity": maxOpacity,
            } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
