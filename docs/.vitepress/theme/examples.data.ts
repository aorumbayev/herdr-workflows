import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExampleCard } from "../../../scripts/build-examples";

const SCRIPT = fileURLToPath(new URL("../../../scripts/build-examples.ts", import.meta.url));
const EXAMPLES_GLOB = fileURLToPath(new URL("../../../examples/*.yaml", import.meta.url));

declare const data: ExampleCard[];
export { data };

export default {
  watch: [EXAMPLES_GLOB],
  load: (): ExampleCard[] =>
    JSON.parse(execFileSync("bun", [SCRIPT], { encoding: "utf8" })) as ExampleCard[],
};
