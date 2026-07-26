import {
  DEFAULT_BACKGROUND_RGB,
  DEFAULT_FOREGROUND_RGB,
  RGBA,
  type CliRenderer,
  type ColorInput,
  type TerminalColors,
  type ThemeMode,
} from "@opentui/core";

/** WCAG AA for normal text. */
const MIN_CONTRAST = 4.5;

function hexOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^#([0-9a-fA-F]{6})/.exec(value);
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

function rgbHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
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
  return rgbHex([c(ar, br), c(ag, bg), c(ab, bb)]);
}

/** Soften fg toward bg only while contrast against bg stays usable. */
function mutedOn(bg: string, fg: string): string {
  const mixed = mix(fg, bg, 0.35);
  return contrastRatio(mixed, bg) >= 3 ? mixed : fg;
}

export type HostTheme = {
  text: { fg: ColorInput };
  input: {
    backgroundColor: ColorInput;
    textColor: ColorInput;
    focusedBackgroundColor: ColorInput;
    focusedTextColor: ColorInput;
    placeholderColor: ColorInput;
  };
  select: {
    backgroundColor: ColorInput;
    textColor: ColorInput;
    focusedBackgroundColor: ColorInput;
    focusedTextColor: ColorInput;
    selectedBackgroundColor: ColorInput;
    selectedTextColor: ColorInput;
    descriptionColor: ColorInput;
    selectedDescriptionColor: ColorInput;
  };
};

function modeFallback(mode: ThemeMode | null): { fg: string; bg: string } {
  const ink = rgbHex(DEFAULT_FOREGROUND_RGB);
  const paper = rgbHex(DEFAULT_BACKGROUND_RGB);
  if (mode === "light") return { fg: paper, bg: ink };
  return { fg: ink, bg: paper };
}

function pickSelection(
  colors: TerminalColors | null,
  fgHex: string,
  bgHex: string,
  fallback: { fg: string; bg: string },
): { selBg: string; selFg: string } {
  const hiBg = hexOrNull(colors?.highlightBackground);
  const hiFg = hexOrNull(colors?.highlightForeground);
  if (hiBg && hiFg && contrastRatio(hiBg, hiFg) >= MIN_CONTRAST) {
    return { selBg: hiBg, selFg: hiFg };
  }
  if (contrastRatio(fgHex, bgHex) >= MIN_CONTRAST) {
    // Reverse video as RGB (not SGR default slots — those flip by paint side).
    return { selBg: fgHex, selFg: bgHex };
  }
  return { selBg: fallback.fg, selFg: fallback.bg };
}

function pickMuted(colors: TerminalColors | null, fgHex: string, bgHex: string): ColorInput {
  const paletteMuted = hexOrNull(colors?.palette?.[8] ?? null);
  if (paletteMuted && contrastRatio(paletteMuted, bgHex) >= 3) {
    return RGBA.fromIndex(8, paletteMuted);
  }
  return RGBA.fromHex(mutedOn(bgHex, fgHex));
}

/**
 * Build TUI colors from a detected host palette.
 *
 * Body text → terminal default fg. Selection → reverse video of host defaults
 * (or highlight pair if AA). Selected description shares selected title ink.
 */
export function themeFromPalette(
  colors: TerminalColors | null,
  mode: ThemeMode | null = null,
): HostTheme {
  const fallback = modeFallback(mode);
  const fgHex = hexOrNull(colors?.defaultForeground) ?? fallback.fg;
  const bgHex = hexOrNull(colors?.defaultBackground) ?? fallback.bg;
  const { selBg, selFg } = pickSelection(colors, fgHex, bgHex, fallback);

  const fg = RGBA.defaultForeground(fgHex);
  const muted = pickMuted(colors, fgHex, bgHex);
  const selectedBg = RGBA.fromHex(selBg);
  const selectedFg = RGBA.fromHex(selFg);

  return {
    text: { fg },
    input: {
      backgroundColor: "transparent",
      textColor: fg,
      focusedBackgroundColor: "transparent",
      focusedTextColor: fg,
      placeholderColor: muted,
    },
    select: {
      backgroundColor: "transparent",
      textColor: fg,
      focusedBackgroundColor: "transparent",
      focusedTextColor: fg,
      selectedBackgroundColor: selectedBg,
      selectedTextColor: selectedFg,
      descriptionColor: muted,
      selectedDescriptionColor: selectedFg,
    },
  };
}

export async function resolveHostTheme(renderer: CliRenderer): Promise<HostTheme> {
  const mode = await renderer.waitForThemeMode(300);
  try {
    const colors = await renderer.getPalette({ size: 16, timeout: 400 });
    return themeFromPalette(colors, mode);
  } catch {
    return themeFromPalette(null, mode);
  }
}
