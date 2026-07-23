import { Select, type SelectRenderableOptions } from "@opentui/core";
import type { HostTheme } from "./theme";

type SelectListOpts = Pick<SelectRenderableOptions, "showDescription" | "flexGrow" | "height"> & {
  theme: HostTheme["select"];
};

/** Shared Select defaults for picker lists. */
export function SelectList(id: string, opts: SelectListOpts) {
  const { theme, showDescription = true, flexGrow = 1, height } = opts;
  return Select({
    id,
    flexGrow,
    height,
    options: [],
    showDescription,
    showScrollIndicator: true,
    wrapSelection: true,
    itemSpacing: 0,
    ...theme,
  });
}
