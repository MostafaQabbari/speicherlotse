export interface ChartPoint {
  /** Milliseconds since 1970. */
  readonly t: number;
  readonly v: number;
}

export interface ChartGeometry {
  /** SVG path: one "M x y L x y …" run per stretch of consecutive points; a gap in the data breaks the line. */
  readonly path: string;
  readonly dots: readonly { x: number; y: number }[];
  readonly min: number;
  readonly max: number;
  readonly tMin: number;
  readonly tMax: number;
}

export interface ChartBox {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Points are in time order. `null` marks a moment where the channel has no value (it breaks the line). */
export function layout(points: readonly (ChartPoint | null)[], box: ChartBox): ChartGeometry | undefined {
  const real = points.filter((p): p is ChartPoint => p !== null);
  if (real.length === 0) return undefined;

  let min = Math.min(...real.map((p) => p.v));
  let max = Math.max(...real.map((p) => p.v));
  if (min === max) {
    // A flat line would sit on the edge; give it room.
    min -= 1;
    max += 1;
  }
  const tMin = Math.min(...real.map((p) => p.t));
  const tMax = Math.max(...real.map((p) => p.t));
  const innerWidth = box.width - box.left - box.right;
  const innerHeight = box.height - box.top - box.bottom;
  const x = (t: number) => (tMax === tMin ? box.left + innerWidth / 2 : box.left + ((t - tMin) / (tMax - tMin)) * innerWidth);
  const y = (v: number) => box.top + (1 - (v - min) / (max - min)) * innerHeight;
  const round = (n: number) => Math.round(n * 10) / 10;

  const runs: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run = '';
  for (const p of points) {
    if (p === null) {
      if (run) runs.push(run);
      run = '';
      continue;
    }
    const px = round(x(p.t));
    const py = round(y(p.v));
    dots.push({ x: px, y: py });
    run += `${run ? ' L' : 'M'} ${px} ${py}`;
  }
  if (run) runs.push(run);
  return { path: runs.join(' '), dots, min, max, tMin, tMax };
}
