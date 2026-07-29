import { describe, expect, test } from "bun:test";
import { browserOpenArgv } from "../src/web/browser";

describe("browserOpenArgv", () => {
  test("selects the host opener", () => {
    expect(browserOpenArgv("http://127.0.0.1:9", "darwin")).toEqual(["open", "http://127.0.0.1:9"]);
    expect(browserOpenArgv("http://127.0.0.1:9", "linux")).toEqual([
      "xdg-open",
      "http://127.0.0.1:9",
    ]);
  });
});
