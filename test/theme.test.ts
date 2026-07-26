import { describe, expect, test } from "bun:test";
import { RGBA, type TerminalColors } from "@opentui/core";
import { themeFromPalette } from "../src/tui/theme";

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
  test("selection is reverse video of host defaults, baked to literal rgb", () => {
    const theme = themeFromPalette(
      colors({ defaultForeground: "#c0caf5", defaultBackground: "#1a1b26" }),
    );
    expect(hexOf(theme.select.selectedBackgroundColor)).toBe("#c0caf5");
    expect(hexOf(theme.select.selectedTextColor)).toBe("#1a1b26");
    expect(hexOf(theme.select.selectedDescriptionColor)).toBe("#1a1b26");
    // rgb, not default — a default-intent bg would emit SGR 49 and vanish
    expect((theme.select.selectedBackgroundColor as RGBA).intent).toBe("rgb");
  });

  test("body text defers to the terminal's default foreground", () => {
    const theme = themeFromPalette(colors({ defaultForeground: "#c0caf5" }));
    expect((theme.text.fg as RGBA).intent).toBe("default");
    expect((theme.input.textColor as RGBA).intent).toBe("default");
    expect(theme.input.backgroundColor).toBe("transparent");
  });

  test("muted text defers to palette slot 8", () => {
    const theme = themeFromPalette(
      colors({ palette: Array.from({ length: 16 }, (_, i) => (i === 8 ? "#6e7681" : null)) }),
    );
    const muted = theme.select.descriptionColor as RGBA;
    expect(muted.intent).toBe("indexed");
    expect(muted.slot).toBe(8);
    expect(hexOf(muted)).toBe("#6e7681");
  });

  test("no palette answer falls back to terminal palette slots", () => {
    const theme = themeFromPalette(null);
    const selBg = theme.select.selectedBackgroundColor as RGBA;
    const selFg = theme.select.selectedTextColor as RGBA;
    expect(selBg.intent).toBe("indexed");
    expect(selBg.slot).toBe(7);
    expect(selFg.slot).toBe(0);
    expect((theme.text.fg as RGBA).intent).toBe("default");
  });
});
