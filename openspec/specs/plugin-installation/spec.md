# plugin-installation Specification

## Purpose
Versioned releases, Go-compiled remote installation, native setup, CLI/keybinding installation, repeat installation, and Herdr-owned update contract for the plugin.

## Requirements
### Requirement: Releases publish versioned tags and notes
Every automated plugin release MUST derive its version and notes from conventional commits, remain within `0.x` until the project explicitly leaves alpha, update `herdr-plugin.toml` as the product-version source, and publish no npm package and no binary assets. Breaking commits MUST increment the minor version while the product major is zero. The first automated release MUST use an established `v0.1.0` baseline so earlier repository history cannot force a `1.0.0` release. The published tag MUST equal the manifest version it releases.

#### Scenario: Release publishes tag and notes
- **WHEN** semantic release selects a new version from conventional commits
- **THEN** it updates `herdr-plugin.toml`, commits with a release-loop skip marker, tags `v<version>`, and publishes a GitHub Release containing generated notes and no binary assets

#### Scenario: Breaking alpha change
- **WHEN** a conventional commit marks a breaking change while the current product major is zero
- **THEN** release analysis increments the minor version rather than publishing `1.0.0`

### Requirement: Remote installation compiles the checkout with Go
The plugin manifest MUST declare `linux` and `macos` as its only platforms, so Herdr refuses native Windows installation at install time with its platform error. Windows users are supported through WSL2, where Linux behavior applies unchanged. Remote installation MUST run entirely through Herdr's managed build: a preflight that names the required minimum Go version and fails with it when the host Go toolchain is absent or older, `go build -o bin/herdr-workflows .` producing the manifest command binary from the checkout, and `bin/herdr-workflows setup` installing the host commands. Herdr MUST remain responsible for registering, replacing, and rolling back the managed checkout. Linked development checkouts MUST keep compiling the working tree through `go run ./scripts/install-dev` without manifest build commands.

#### Scenario: Fresh install with Go present
- **WHEN** a user with Herdr and a supported Go toolchain runs `herdr plugin install aorumbayev/herdr-workflows`
- **THEN** the build compiles the checkout binary from the pinned module dependencies, runs native setup, and Herdr registers the plugin

#### Scenario: Go missing or too old
- **WHEN** the host has no Go toolchain or a Go older than the required minimum
- **THEN** the build fails naming the required minimum Go version before compilation, and Herdr leaves the prior installation in place

#### Scenario: Native Windows install refused
- **WHEN** Herdr on native Windows previews the manifest
- **THEN** installation fails with Herdr's unsupported-platform error rather than a broken runtime

### Requirement: Native setup installs executable host commands
The compiled binary MUST provide a hidden setup operation that installs `herdr-workflows` and `hwf` under `$XDG_BIN_HOME` or `~/.local/bin`, using symlinks with a copy fallback. Setup MUST name that directory when it is absent from `PATH`. Setup MUST remain nonfatal to Herdr plugin registration but MUST name every artifact path, permission, foreign entry, or directory that it skips.

#### Scenario: Install directory absent from PATH
- **WHEN** setup writes commands into a directory the current PATH does not contain
- **THEN** it names the directory and states that it must be added to PATH

#### Scenario: Foreign entry is preserved
- **WHEN** a destination command was not installed by this plugin
- **THEN** setup leaves it unchanged and names the conflicting entry

### Requirement: Repeated setup safely replaces owned commands
Setup MUST recognize commands it installed previously and replace only those, refusing foreign files. A second installation MUST leave the PATH command, managed checkout binary, manifest version, and Herdr registry describing the same release.

#### Scenario: Repeat install remains coherent
- **WHEN** the plugin is installed again over an owned prior installation
- **THEN** the PATH command and Herdr-managed plugin both report the new manifest version

### Requirement: Keybindings are written to the config Herdr reads
Native setup MUST write the picker binding to the `config.toml` the installed Herdr reads, preferring `HERDR_CONFIG_PATH` and otherwise using the XDG path. It MUST preserve temporary validation, atomic replacement, backup, idempotency, and stale herdr-workflows binding cleanup. Reported success MUST mean Herdr validates the selected file and reads the binding.

#### Scenario: Binding reaches the active config
- **WHEN** setup runs on a supported platform
- **THEN** the picker binding is written to the Herdr config in use and works after config reload

#### Scenario: Existing binding remains idempotent
- **WHEN** setup runs again after installing the current picker binding
- **THEN** it leaves one live binding and reports that no duplicate was needed
