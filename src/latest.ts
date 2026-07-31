/** Monotonic latest-wins token: older in-flight work checks `current(token)` before applying. */
export function latest(): {
  begin(): number;
  current(token: number): boolean;
  bump(): number;
} {
  let gen = 0;
  return {
    begin() {
      gen += 1;
      return gen;
    },
    current(token: number) {
      return token === gen;
    },
    bump() {
      gen += 1;
      return gen;
    },
  };
}
