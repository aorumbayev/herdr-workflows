import { describe, expect, test } from "bun:test";
import type { ChromeOption } from "../../src/tui/picker-chrome";
import { assignListOptions } from "../../src/tui/picker-chrome";

/** Mirrors OpenTUI Select: options clamps silently; setSelectedIndex always emits. */
function fakeSelect(initial: ChromeOption[]) {
  let options = initial;
  let selectedIndex = 0;
  const selectionChanged: Array<() => void> = [];
  return {
    get options() {
      return options;
    },
    set options(next: ChromeOption[]) {
      options = next;
      selectedIndex = Math.min(selectedIndex, Math.max(0, next.length - 1));
    },
    getSelectedIndex() {
      return selectedIndex;
    },
    setSelectedIndex(index: number) {
      if (index < 0 || index >= options.length) return;
      selectedIndex = index;
      for (const cb of selectionChanged) cb();
    },
    onSelectionChanged(cb: () => void) {
      selectionChanged.push(cb);
    },
  };
}

describe("assignListOptions", () => {
  test("does not emit selectionChanged when index stays in range", () => {
    const list = fakeSelect([
      { name: "a", description: "", value: "a" },
      { name: "b", description: "", value: "b" },
    ]);
    list.setSelectedIndex(1);
    let emits = 0;
    list.onSelectionChanged(() => {
      emits += 1;
    });

    assignListOptions(list, list.options);
    expect(emits).toBe(0);
    expect(list.getSelectedIndex()).toBe(1);
  });

  test("selectionChanged handler that calls setOptions does not recurse", () => {
    const list = fakeSelect([
      { name: "a", description: "", value: "a" },
      { name: "b", description: "", value: "b" },
    ]);
    list.setSelectedIndex(0);
    let depth = 0;
    let maxDepth = 0;

    const setOptions = (next: ChromeOption[]) => {
      assignListOptions(list, next);
    };

    list.onSelectionChanged(() => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      if (depth > 20) throw new Error("Maximum call stack size exceeded");
      setOptions(
        list.options.map((opt, i) => ({
          ...opt,
          name:
            i === list.getSelectedIndex()
              ? `> ${opt.name.replace(/^> /, "")}`
              : opt.name.replace(/^> /, ""),
        })),
      );
      depth -= 1;
    });

    expect(() => setOptions(list.options)).not.toThrow();
    expect(maxDepth).toBe(0);
  });

  test("setSelectedIndex clamp during setOptions recurses under OpenTUI emit", () => {
    const list = fakeSelect([
      { name: "a", description: "", value: "a" },
      { name: "b", description: "", value: "b" },
    ]);
    const setOptions = (next: ChromeOption[]) => {
      list.options = next;
      if (list.options.length > 0) {
        list.setSelectedIndex(Math.min(list.getSelectedIndex(), list.options.length - 1));
      }
    };
    list.onSelectionChanged(() => {
      setOptions(list.options);
    });
    expect(() => setOptions(list.options)).toThrow("Maximum call stack size exceeded");
  });
});
