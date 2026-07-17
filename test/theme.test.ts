import { describe, expect, test } from "bun:test";
import { RGBA, type TerminalColors } from "@opentui/core";
import { contrastRatio, themeFromPalette } from "../src/tui/theme";

function colors(partial: Partial<TerminalColors>): TerminalColors {
  return {
    palette: [],
    defaultForeground: null,
    defaultBackground: null,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
    ...partial,
  };
}

function hexOf(c: string | RGBA): string {
  if (typeof c === "string") return c;
  const [r, g, b] = c.toInts();
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

describe("themeFromPalette", () => {
  test("reverse-video selection from host defaults with AA contrast", () => {
    const theme = themeFromPalette(
      colors({ defaultForeground: "#c0caf5", defaultBackground: "#1a1b26" }),
      "dark",
    );
    const selBg = hexOf(theme.select.selectedBackgroundColor);
    const selFg = hexOf(theme.select.selectedTextColor);
    expect(selBg).toBe("#c0caf5");
    expect(selFg).toBe("#1a1b26");
    expect(hexOf(theme.select.selectedDescriptionColor)).toBe(selFg);
    expect(contrastRatio(selBg, selFg)).toBeGreaterThanOrEqual(4.5);
    expect(theme.select.selectedBackgroundColor).toBeInstanceOf(RGBA);
    expect((theme.select.selectedBackgroundColor as RGBA).intent).toBe("rgb");
    expect((theme.select.textColor as RGBA).intent).toBe("default");
  });

  test("rejects low-contrast highlight pair; falls back to reverse video", () => {
    const theme = themeFromPalette(
      colors({
        defaultForeground: "#e6edf3",
        defaultBackground: "#0d1117",
        // light-on-light — unusable, like the washed-out selection case
        highlightBackground: "#7aa2f7",
        highlightForeground: "#a9b1d6",
      }),
      "dark",
    );
    expect(hexOf(theme.select.selectedBackgroundColor)).toBe("#e6edf3");
    expect(hexOf(theme.select.selectedTextColor)).toBe("#0d1117");
    expect(hexOf(theme.select.selectedDescriptionColor)).toBe("#0d1117");
  });

  test("uses highlight pair when contrast is good", () => {
    const theme = themeFromPalette(
      colors({
        defaultForeground: "#e6edf3",
        defaultBackground: "#0d1117",
        highlightBackground: "#1f6feb",
        highlightForeground: "#ffffff",
      }),
      "dark",
    );
    expect(hexOf(theme.select.selectedBackgroundColor)).toBe("#1f6feb");
    expect(hexOf(theme.select.selectedTextColor)).toBe("#ffffff");
  });

  test("light mode fallback without palette", () => {
    const theme = themeFromPalette(null, "light");
    expect(hexOf(theme.select.selectedBackgroundColor)).toBe("#000000");
    expect(hexOf(theme.select.selectedTextColor)).toBe("#ffffff");
    expect(theme.input.backgroundColor).toBe("transparent");
  });

  test("muted description contrasts with host background", () => {
    const theme = themeFromPalette(
      colors({
        defaultForeground: "#e6edf3",
        defaultBackground: "#0d1117",
        palette: Array.from({ length: 16 }, (_, i) => (i === 8 ? "#6e7681" : null)),
      }),
      "dark",
    );
    expect(contrastRatio("#0d1117", hexOf(theme.select.descriptionColor))).toBeGreaterThanOrEqual(
      3,
    );
  });
});
