import type { ChromeOption } from "../src/tui/picker-chrome";
import type { PickerChrome } from "../src/tui/picker-chrome";
import { LIST_VIEWPORT } from "../src/tui/picker-chrome";

type BrowserShowOpts = Parameters<PickerChrome["showBrowser"]>[0];

export type FakePickerChrome = PickerChrome & {
  lastStatus(): string;
  statusVisible(): boolean;
  lastFooter(): string;
  lastDetail(): string;
  lastHint(): string | undefined;
  lastBrowserOpts(): BrowserShowOpts | undefined;
  layout(): "browser" | "detail" | "hidden" | "list-only";
  destroyed: boolean;
  listHeight: number;
};

export function fakePickerChrome(overrides: Partial<PickerChrome> = {}): FakePickerChrome {
  let options: ChromeOption[] = [];
  let selected = 0;
  let filter = "";
  let filterPlaceholder = "filter workflows...";
  let filterVisible = true;
  let footer = "";
  let detail = "";
  let status = "";
  let statusShown = false;
  let hint: string | undefined;
  let promptValue = "";
  let layout: "browser" | "detail" | "hidden" | "list-only" = "browser";
  let lastBrowser: BrowserShowOpts | undefined;
  let listHeight = 99;
  let destroyed = false;
  const listSelect: Array<(option: ChromeOption) => void> = [];

  const chrome: FakePickerChrome = {
    showBrowser(opts = {}) {
      layout = "browser";
      lastBrowser = opts;
      filterVisible = opts.showFilter ?? true;
      if (opts.filterPlaceholder !== undefined) filterPlaceholder = opts.filterPlaceholder;
      if (opts.filterValue !== undefined) filter = opts.filterValue;
      listHeight = opts.listHeight ?? LIST_VIEWPORT;
      hint = undefined;
    },
    hideBrowser() {
      layout = "hidden";
      filterVisible = false;
      hint = undefined;
    },
    showList() {
      if (layout === "hidden") layout = "list-only";
    },
    hideList() {
      detail = "";
    },
    showDetailLayout() {
      layout = "detail";
      filterVisible = false;
      hint = undefined;
    },
    status(content) {
      status = content;
      statusShown = true;
    },
    clearStatus() {
      status = "";
      statusShown = false;
    },
    focusPrompt(_placeholder, value) {
      promptValue = value;
    },
    setPromptValue(value) {
      promptValue = value;
    },
    setFooter(text) {
      footer = text;
    },
    setDetail(content) {
      detail = content;
    },
    setOptions(next) {
      options = next;
      if (options.length > 0) selected = Math.min(selected, options.length - 1);
    },
    updateHint(text) {
      hint = text;
    },
    setRule() {},
    filterValue() {
      return filter;
    },
    setFilterValue(value) {
      filter = value;
    },
    setFilterPlaceholder(text) {
      filterPlaceholder = text;
    },
    focusFilter() {},
    filterVisible() {
      return filterVisible;
    },
    focusList() {},
    selectedIndex() {
      return selected;
    },
    setSelectedIndex(i) {
      selected = i;
    },
    options() {
      return options;
    },
    moveUp() {
      if (options.length === 0) return;
      selected = (selected - 1 + options.length) % options.length;
    },
    moveDown() {
      if (options.length === 0) return;
      selected = (selected + 1) % options.length;
    },
    selectCurrent() {
      const option = options[selected];
      if (!option) return;
      for (const cb of listSelect) cb(option);
    },
    destroy() {
      destroyed = true;
    },
    whenDestroyed() {},
    on(event, cb) {
      if (event === "list-select") listSelect.push(cb as (option: ChromeOption) => void);
    },
    lastStatus() {
      return status;
    },
    statusVisible() {
      return statusShown;
    },
    lastFooter() {
      return footer;
    },
    lastDetail() {
      return detail;
    },
    lastHint() {
      return hint;
    },
    lastBrowserOpts() {
      return lastBrowser;
    },
    layout() {
      return layout;
    },
    get destroyed() {
      return destroyed;
    },
    get listHeight() {
      return listHeight;
    },
    ...overrides,
  };

  void filterPlaceholder;
  void promptValue;

  return chrome;
}
