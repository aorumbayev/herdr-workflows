import {
  Box,
  BoxRenderable,
  createCliRenderer,
  Input,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  Select,
  SelectRenderable,
  SelectRenderableEvents,
  Text,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type ColorInput,
  type KeyEvent,
  type SelectOption,
  type TerminalColors,
} from "@opentui/core";

/** Shared with runs browser Select height — six visible rows, scroll for the rest. */
export const LIST_VIEWPORT = 6;

export type ChromeKeyEvent = KeyEvent;
export type ChromeOption = SelectOption;
export { RGBA };
export type { CliRenderer, TerminalColors };

export type HostTheme = {
  text: { fg: ColorInput };
  warn: ColorInput;
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
  const warn = RGBA.fromIndex(3, hexOrNull(colors?.palette?.[3] ?? null) ?? undefined);
  const sel = selection(colors);

  return {
    text: { fg },
    warn,
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

const STANDALONE_PALETTE_TIMEOUT_MS = 400;
// context: Herdr plugin panes inject HERDR_PLUGIN_ENTRYPOINT_ID; measured popup answer matches at 1ms vs 400ms.
const HERDR_PANE_PALETTE_TIMEOUT_MS = 1;

function hostPaletteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.HERDR_PLUGIN_ENTRYPOINT_ID
    ? HERDR_PANE_PALETTE_TIMEOUT_MS
    : STANDALONE_PALETTE_TIMEOUT_MS;
}

export async function resolveHostTheme(renderer: CliRenderer): Promise<HostTheme> {
  try {
    return themeFromPalette(
      await renderer.getPalette({ size: 16, timeout: hostPaletteTimeoutMs() }),
    );
  } catch {
    return themeFromPalette(null);
  }
}

/**
 * context: OpenTUI Select.options clamps `_selectedIndex` silently. `setSelectedIndex`
 * always emits `selectionChanged`, so calling it from setOptions re-enters the picker's
 * list-selection-changed → refreshListChrome → setOptions loop.
 */
export function assignListOptions(
  list: { options: ChromeOption[] },
  options: ChromeOption[],
): void {
  list.options = options;
}

type StatusOpts = { flexGrow?: number; warn?: boolean };

type BrowserShowOpts = {
  filterPlaceholder?: string;
  filterValue?: string;
  showFilter?: boolean;
  listHeight?: number;
};

type ChromeEventMap = {
  "list-select": (option: ChromeOption) => void;
  "list-selection-changed": () => void;
  "filter-input": () => void;
  "prompt-enter": (value: string) => void;
  keypress: (key: ChromeKeyEvent) => void;
  resize: (width: number) => void;
};

/**
 * Semantic chrome surface for the picker. OpenTUI widgets stay private —
 * callers never receive renderables.
 */
export type PickerChrome = {
  showBrowser(opts?: BrowserShowOpts): void;
  hideBrowser(): void;
  showList(ruleContent: string): void;
  hideList(): void;
  showDetailLayout(): void;
  status(content: string, opts?: StatusOpts): void;
  clearStatus(): void;
  focusPrompt(placeholder: string, value: string): void;
  setPromptValue(value: string): void;
  setFooter(text: string): void;
  setDetail(content: string): void;
  setOptions(options: ChromeOption[]): void;
  updateHint(text: string | undefined): void;
  setRule(content: string): void;
  filterValue(): string;
  setFilterValue(value: string): void;
  setFilterPlaceholder(text: string): void;
  focusFilter(): void;
  filterVisible(): boolean;
  focusList(): void;
  selectedIndex(): number;
  setSelectedIndex(i: number): void;
  options(): ChromeOption[];
  moveUp(): void;
  moveDown(): void;
  selectCurrent(): void;
  destroy(): void;
  whenDestroyed(cb: () => void): void;
  on<E extends keyof ChromeEventMap>(event: E, cb: ChromeEventMap[E]): void;
};

type ChromeWidgets = {
  renderer: CliRenderer;
  filterRow: BoxRenderable;
  filter: InputRenderable;
  updateHint: TextRenderable;
  listBlock: BoxRenderable;
  list: SelectRenderable;
  status: TextRenderable;
  detail: TextRenderable;
  rule: TextRenderable;
  promptInput: InputRenderable;
  footer: TextRenderable;
};

function buildBrowserChrome(theme: HostTheme) {
  return [
    Box(
      { id: "filter-row", flexDirection: "row", width: "100%" },
      Text({ content: "/ ", ...theme.text }),
      Input({ id: "filter", flexGrow: 1, placeholder: "filter workflows...", ...theme.input }),
      Text({
        id: "update-hint",
        content: "",
        visible: false,
        attributes: TextAttributes.DIM,
        ...theme.text,
      }),
    ),
    Box(
      { id: "list-block", flexDirection: "column", flexGrow: 0 },
      Text({ content: " " }),
      Select({
        id: "list",
        flexGrow: 0,
        height: LIST_VIEWPORT,
        options: [],
        showDescription: false,
        showScrollIndicator: false,
        showSelectionIndicator: false,
        wrapSelection: true,
        itemSpacing: 0,
        ...theme.select,
      }),
      Text({ content: " " }),
    ),
  ] as const;
}

function buildDetailStack(theme: HostTheme, listHint: string) {
  return [
    Text({
      id: "status",
      content: "",
      visible: false,
      flexGrow: 1,
      ...theme.text,
    }),
    Text({ id: "detail", content: "", height: 2, attributes: TextAttributes.DIM, ...theme.text }),
    Text({
      id: "rule",
      content: "",
      attributes: TextAttributes.DIM,
      ...theme.text,
    }),
    Input({
      id: "prompt-input",
      visible: false,
      width: "100%",
      placeholder: "prompt...",
      ...theme.input,
    }),
    Text({ id: "footer", content: listHint, attributes: TextAttributes.DIM, ...theme.text }),
  ] as const;
}

function collectWidgets(renderer: CliRenderer): ChromeWidgets {
  return {
    renderer,
    filterRow: renderer.root.findDescendantById("filter-row") as BoxRenderable,
    filter: renderer.root.findDescendantById("filter") as InputRenderable,
    updateHint: renderer.root.findDescendantById("update-hint") as TextRenderable,
    listBlock: renderer.root.findDescendantById("list-block") as BoxRenderable,
    list: renderer.root.findDescendantById("list") as SelectRenderable,
    status: renderer.root.findDescendantById("status") as TextRenderable,
    detail: renderer.root.findDescendantById("detail") as TextRenderable,
    rule: renderer.root.findDescendantById("rule") as TextRenderable,
    promptInput: renderer.root.findDescendantById("prompt-input") as InputRenderable,
    footer: renderer.root.findDescendantById("footer") as TextRenderable,
  };
}

function hideUpdateHint(w: ChromeWidgets): void {
  w.updateHint.visible = false;
  w.updateHint.content = "";
}

function createChrome(w: ChromeWidgets, theme: HostTheme): PickerChrome {
  return {
    showBrowser(opts = {}) {
      w.promptInput.visible = false;
      const showFilter = opts.showFilter ?? true;
      w.filterRow.visible = showFilter;
      w.filter.visible = showFilter;
      if (opts.filterPlaceholder !== undefined) w.filter.placeholder = opts.filterPlaceholder;
      if (opts.filterValue !== undefined) w.filter.value = opts.filterValue;
      w.listBlock.visible = true;
      w.list.visible = true;
      w.list.flexGrow = 0;
      w.list.height = opts.listHeight ?? LIST_VIEWPORT;
      hideUpdateHint(w);
    },
    hideBrowser() {
      w.filterRow.visible = false;
      w.listBlock.visible = false;
      w.list.visible = false;
      w.list.flexGrow = 0;
      w.detail.visible = false;
      w.rule.visible = false;
      w.promptInput.visible = false;
      hideUpdateHint(w);
    },
    showList(ruleContent) {
      w.detail.visible = true;
      w.rule.visible = true;
      w.rule.content = ruleContent;
    },
    hideList() {
      w.detail.visible = false;
      w.detail.content = "";
      w.rule.visible = false;
    },
    showDetailLayout() {
      w.filterRow.visible = false;
      w.listBlock.visible = false;
      w.list.visible = false;
      w.list.flexGrow = 0;
      w.detail.visible = false;
      w.detail.content = "";
      w.rule.visible = false;
      w.promptInput.visible = false;
      hideUpdateHint(w);
    },
    status(content, options = {}) {
      w.status.visible = true;
      w.status.flexGrow = options.flexGrow ?? 0;
      w.status.fg = options.warn ? theme.warn : theme.text.fg;
      w.status.attributes = TextAttributes.NONE;
      w.status.content = content;
    },
    clearStatus() {
      w.status.visible = false;
      w.status.content = "";
      w.status.flexGrow = 0;
    },
    focusPrompt(placeholder, value) {
      w.promptInput.visible = true;
      w.promptInput.placeholder = placeholder;
      w.promptInput.value = value;
      w.promptInput.focus();
    },
    setPromptValue(value) {
      w.promptInput.value = value;
    },
    setFooter(text) {
      w.footer.content = text;
    },
    setDetail(content) {
      w.detail.content = content;
    },
    setOptions(options) {
      assignListOptions(w.list, options);
    },
    updateHint(text) {
      if (!text) {
        hideUpdateHint(w);
        return;
      }
      w.updateHint.content = text;
      w.updateHint.visible = true;
    },
    setRule(content) {
      w.rule.content = content;
    },
    filterValue() {
      return w.filter.value;
    },
    setFilterValue(value) {
      w.filter.value = value;
    },
    setFilterPlaceholder(text) {
      w.filter.placeholder = text;
    },
    focusFilter() {
      w.filter.focus();
    },
    filterVisible() {
      return w.filter.visible;
    },
    focusList() {
      w.list.focus();
    },
    selectedIndex() {
      return w.list.getSelectedIndex();
    },
    setSelectedIndex(i) {
      w.list.setSelectedIndex(i);
    },
    options() {
      return w.list.options;
    },
    moveUp() {
      w.list.moveUp();
    },
    moveDown() {
      w.list.moveDown();
    },
    selectCurrent() {
      if (w.list.options.length > 0) w.list.selectCurrent();
    },
    destroy() {
      w.renderer.destroy();
    },
    whenDestroyed(cb) {
      w.renderer.on("destroy", cb);
    },
    on(event, cb) {
      if (event === "list-select") {
        w.list.on(SelectRenderableEvents.ITEM_SELECTED, (_i, option) => {
          (cb as ChromeEventMap["list-select"])(option);
        });
        return;
      }
      if (event === "list-selection-changed") {
        w.list.on(
          SelectRenderableEvents.SELECTION_CHANGED,
          cb as ChromeEventMap["list-selection-changed"],
        );
        return;
      }
      if (event === "filter-input") {
        w.filter.on(InputRenderableEvents.INPUT, cb as ChromeEventMap["filter-input"]);
        return;
      }
      if (event === "prompt-enter") {
        w.promptInput.on(InputRenderableEvents.ENTER, cb as ChromeEventMap["prompt-enter"]);
        return;
      }
      if (event === "keypress") {
        w.renderer.keyInput.on("keypress", cb as ChromeEventMap["keypress"]);
        return;
      }
      w.renderer.on("resize", cb as ChromeEventMap["resize"]);
    },
  };
}

function mountPickerChrome(
  renderer: CliRenderer,
  theme: HostTheme,
  listHint: string,
): PickerChrome {
  renderer.root.add(
    Box(
      {
        flexDirection: "column",
        paddingX: 1,
        paddingY: 0,
        width: "100%",
        height: "100%",
        gap: 0,
      },
      ...buildBrowserChrome(theme),
      ...buildDetailStack(theme, listHint),
    ),
  );
  return createChrome(collectWidgets(renderer), theme);
}

export type MountedChrome = {
  chrome: PickerChrome;
  theme: HostTheme;
  width: number;
};

/** Own the OpenTUI renderer — the only factory that calls `createCliRenderer`. */
export async function mountChrome(opts: {
  listHint: string;
  exitOnCtrlC?: boolean;
  prependInputHandlers?: ((sequence: string) => boolean)[];
}): Promise<MountedChrome> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: opts.exitOnCtrlC ?? true,
    ...(opts.prependInputHandlers !== undefined
      ? { prependInputHandlers: opts.prependInputHandlers }
      : {}),
  });
  const theme = await resolveHostTheme(renderer);
  const chrome = mountPickerChrome(renderer, theme, opts.listHint);
  return { chrome, theme, width: renderer.width };
}

const ELLIPSIS = "...";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Select name indent: contentX+1+indicatorWidth with indicator off. */
export const ROW_TEXT_INDENT = 3;

export function columns(text: string): number {
  return Bun.stringWidth(text);
}

export function padColumns(text: string, width: number): string {
  const used = columns(text);
  if (used >= width) return text;
  return `${text}${" ".repeat(width - used)}`;
}

function takeColumns(text: string, max: number): string {
  if (max <= 0) return "";
  if (columns(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = columns(segment);
    if (used + w > max) break;
    out += segment;
    used += w;
  }
  return out;
}

/** Truncate to `max` terminal columns at a grapheme boundary. */
export function truncate(text: string, max: number): string {
  if (columns(text) <= max) return text;
  if (max <= 0) return "";
  const ellipsisCols = columns(ELLIPSIS);
  if (max < ellipsisCols) return takeColumns(ELLIPSIS, max);
  return `${takeColumns(text, max - ellipsisCols)}${ELLIPSIS}`;
}

function takeWrappedLine(text: string, budget: number): string {
  if (columns(text) <= budget) return text;
  const window = takeColumns(text, budget);
  const space = window.lastIndexOf(" ");
  if (space > 0) return window.slice(0, space);
  return window;
}

export function formatDetailLines(description: string, contentWidth: number): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const indent = " ".repeat(ROW_TEXT_INDENT);
  const budget = Math.max(0, contentWidth - ROW_TEXT_INDENT);
  const line1 = takeWrappedLine(text, budget);
  const rest = text.slice(line1.length).trimStart();
  if (!rest) return `${indent}${line1}`;
  const line2 = columns(rest) <= budget ? rest : truncate(rest, budget);
  return `${indent}${line1}\n${indent}${line2}`;
}

export { ELLIPSIS };
