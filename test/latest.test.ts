import { describe, expect, test } from "bun:test";
import { latest } from "../src/latest";

describe("latest-wins token", () => {
  test("older response never overwrites newer", () => {
    const token = latest();
    const first = token.begin();
    const second = token.begin();
    expect(token.current(first)).toBe(false);
    expect(token.current(second)).toBe(true);
    token.bump();
    expect(token.current(second)).toBe(false);
    expect(token.current(token.begin())).toBe(true);
  });
});
