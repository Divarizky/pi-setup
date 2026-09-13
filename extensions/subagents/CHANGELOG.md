# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-06

### Breaking
- Renamed the personal extension and package to `subagents`; install it from the local pi-setup path instead of npm.
- Removed the `Plan` built-in type, scheduling, and the legacy durable-task facade. Use `explore`, `build`, `general`, and workflows instead.
- Reduced persisted settings to the supported nine keys and moved per-type model, max-turns, and thinking overrides to `.pi/subagents.yaml`, editable from `/agents` → Settings.

## [Unreleased]

### Changed
- **Nested delegation depth cap increased to four levels.** The hard limit now allows the main session plus four nested child levels, while still blocking further recursive spawning at the cap.
- **Grandchild-level fan-out is capped at two active children per parent.** Additional launches are ignored until an existing child finishes; the parent continues normally.
- **Invalid agent types now fail closed.** Unknown, disabled, and case-ambiguous names are rejected instead of silently falling back to `general`; the dormant `fallbackSubagent` policy was removed.
- **Removed test-only default-agent controls.** Built-in defaults remain always available and distinguishable from custom agents through `isDefault`.

### Fixed
- **The workflow stand-down now recognises a lowercase `workflow` tool.** Exact matching is preserved so unrelated tools such as `list_workflows` do not disable this extension.

## Historical releases

Detailed pre-2.0 release notes are archived in [docs/archive/changelog-pre-2.0.md](docs/archive/changelog-pre-2.0.md). They describe the upstream baseline and migration history; current behavior is documented above.
