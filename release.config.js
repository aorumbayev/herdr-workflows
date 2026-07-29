/**
 * semantic-release config — product version lives in herdr-plugin.toml only.
 * No @semantic-release/npm: package.json stays 0.0.0-development / private.
 * Plain GitHub Releases with notes only — no drafts, no binary assets.
 */
export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          // While product major is zero, breaking commits bump minor — never 1.0.0.
          { breaking: true, release: "minor" },
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "revert", release: "patch" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
      },
    ],
    [
      "@semantic-release/exec",
      {
        prepareCmd: "bun scripts/prepare-release.ts ${nextRelease.version}",
        successCmd: "bun scripts/record-release-version.ts ${nextRelease.version}",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["herdr-plugin.toml"],
        message: "chore(release): ${nextRelease.version} [skip ci]",
      },
    ],
    [
      "@semantic-release/github",
      {
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
