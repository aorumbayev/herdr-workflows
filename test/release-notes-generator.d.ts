declare module "@semantic-release/release-notes-generator" {
  export function generateNotes(config: object, context: object): Promise<string>;
}
