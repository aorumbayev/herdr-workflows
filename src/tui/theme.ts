import {
  DEFAULT_BACKGROUND_RGB,
  DEFAULT_FOREGROUND_RGB,
  RGBA,
  type CliRenderer,
  type ColorInput,
  type TerminalColors,
  type ThemeMode,
} from "@opentui/core";
import { contrastRatio, hexOrNull, MIN_CONTRAST, mutedOn, rgbHex } from "./contrast";

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
  tab: {
    backgroundColor: ColorInput;
    textColor: ColorInput;
    focusedBackgroundColor: ColorInput;
    focusedTextColor: ColorInput;
    selectedBackgroundColor: ColorInput;
    selectedTextColor: ColorInput;
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
    tab: {
      backgroundColor: "transparent",
      textColor: fg,
      focusedBackgroundColor: "transparent",
      focusedTextColor: fg,
      selectedBackgroundColor: selectedBg,
      selectedTextColor: selectedFg,
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

export { contrastRatio } from "./contrast";
