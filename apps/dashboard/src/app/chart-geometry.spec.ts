import { type ChartBox, layout } from './chart-geometry';

const box: ChartBox = { width: 200, height: 100, left: 10, right: 10, top: 10, bottom: 10 };

describe('layout', () => {
  it('has nothing to draw without values', () => {
    expect(layout([], box)).toBeUndefined();
    expect(layout([null, null], box)).toBeUndefined();
  });

  it('puts the smallest value at the bottom, the largest at the top, the oldest at the left and the newest at the right', () => {
    const g = layout([{ t: 1000, v: 5 }, { t: 2000, v: 15 }], box)!;
    expect(g.dots[0]).toEqual({ x: 10, y: 90 });
    expect(g.dots[1]).toEqual({ x: 190, y: 10 });
    expect([g.min, g.max, g.tMin, g.tMax]).toEqual([5, 15, 1000, 2000]);
    expect(g.path).toBe('M 10 90 L 190 10');
  });

  it('draws a single value as a dot in the middle, and a flat line away from the edge', () => {
    const g = layout([{ t: 5, v: 7 }], box)!;
    expect(g.dots).toEqual([{ x: 100, y: 50 }]);
    expect(g.min).toBeLessThan(7);
    expect(g.max).toBeGreaterThan(7);
  });

  it('breaks the line where a value is missing instead of drawing across the gap', () => {
    const g = layout([{ t: 0, v: 1 }, { t: 1, v: 2 }, null, { t: 3, v: 3 }], box)!;
    expect(g.path.match(/M/g)).toHaveLength(2);
    expect(g.dots).toHaveLength(3);
  });

  it('keeps every point inside the drawing area, whatever the numbers', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ t: i * 7, v: Math.sin(i) * 1e6 - 3e5 }));
    for (const dot of layout(points, box)!.dots) {
      expect(dot.x).toBeGreaterThanOrEqual(10);
      expect(dot.x).toBeLessThanOrEqual(190);
      expect(dot.y).toBeGreaterThanOrEqual(10);
      expect(dot.y).toBeLessThanOrEqual(90);
    }
  });
});
