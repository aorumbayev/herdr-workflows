import manifest from "../herdr-plugin.toml";

export const PRODUCT_VERSION: string = manifest.version;

/**
 * Where the workflow contract this build implements is published. Pinned to the release tag for
 * `PRODUCT_VERSION`, because schemas diverge between versions: a pointer at a moving ref would
 * describe some other build's contract to the editor reading it.
 */
export function workflowSchemaUrl(): string {
  return `https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v${PRODUCT_VERSION}/docs/workflow.schema.json`;
}
