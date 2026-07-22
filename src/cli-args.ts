export function parseArgs(args: string[]): {
  flags: Record<string, string>;
  bools: Set<string>;
  positional: string[];
  multi: Record<string, string[]>;
} {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  const multi: Record<string, string[]> = {};
  const setFlag = (key: string, value: string) => {
    flags[key] = value;
    (multi[key] ??= []).push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      setFlag(a.slice(2, eq), a.slice(eq + 1));
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        setFlag(key, next);
        i += 1;
      } else bools.add(key);
    } else positional.push(a);
  }
  return { flags, bools, positional, multi };
}
