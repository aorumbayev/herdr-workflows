import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ExampleCard = {
  name: string;
  desc: string;
  body: string;
  payload: string;
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLES_GLOB = fileURLToPath(new URL("../../../examples/*.yaml", import.meta.url));

declare const data: ExampleCard[];
export { data };

export default {
  watch: [EXAMPLES_GLOB],
  load: (): ExampleCard[] =>
    JSON.parse(
      execFileSync("go", ["run", "./scripts/build-examples"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ) as ExampleCard[],
};
