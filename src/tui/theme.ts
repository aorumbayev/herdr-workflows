import { RGBA, type CliRenderer, type ColorInput, type TerminalColors } from "@opentui/core";

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

function hexOrNull(value: string | null | undefined): string | null {
  const m = value ? /^#([0-9a-fA-F]{6})/.exec(value) : null;
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/**
 * Selection as reverse video of the host defaults, baked to literal RGB.
 *
 * SGR default slots can't express it: there is one "default" intent and the
 * emitter picks 39 or 49 by paint side, so a default-fg handed to a background
 * comes out as default-bg. Select also never passes TextAttributes.INVERSE.
 * Without a palette answer, fall back to the terminal's own palette slots.
 */
function selection(colors: TerminalColors | null): { bg: ColorInput; fg: ColorInput } {
  const fgHex = hexOrNull(colors?.defaultForeground);
  const bgHex = hexOrNull(colors?.defaultBackground);
  if (!fgHex || !bgHex) return { bg: RGBA.fromIndex(7), fg: RGBA.fromIndex(0) };
  return { bg: RGBA.fromHex(fgHex), fg: RGBA.fromHex(bgHex) };
}

export function themeFromPalette(colors: TerminalColors | null): HostTheme {
  const fg = RGBA.defaultForeground(hexOrNull(colors?.defaultForeground) ?? undefined);
  const muted = RGBA.fromIndex(8, hexOrNull(colors?.palette?.[8] ?? null) ?? undefined);
  const sel = selection(colors);

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
      selectedBackgroundColor: sel.bg,
      selectedTextColor: sel.fg,
      descriptionColor: muted,
      selectedDescriptionColor: sel.fg,
    },
  };
}

export async function resolveHostTheme(renderer: CliRenderer): Promise<HostTheme> {
  try {
    return themeFromPalette(await renderer.getPalette({ size: 16, timeout: 400 }));
  } catch {
    return themeFromPalette(null);
  }
}
