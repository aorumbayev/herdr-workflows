/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

export function hexOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^#([0-9a-fA-F]{6})/.exec(value);
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

export function rgbHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const h = hexOrNull(hex);
  if (!h) return 0;
  const r = Number.parseInt(h.slice(1, 3), 16);
  const g = Number.parseInt(h.slice(3, 5), 16);
  const b = Number.parseInt(h.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const parse = (h: string) =>
    [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[c(ar, br), c(ag, bg), c(ab, bb)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Soften fg toward bg only while contrast against bg stays usable. */
export function mutedOn(bg: string, fg: string): string {
  const mixed = mix(fg, bg, 0.35);
  return contrastRatio(mixed, bg) >= 3 ? mixed : fg;
}
