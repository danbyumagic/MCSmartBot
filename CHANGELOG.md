# Changelog

All notable SmartBotMC changes are documented here. The project uses semantic
versioning; prerelease builds are not considered stable or unattended-operation
ready.

## 0.1.0-beta.2 — 2026-08-15

- Added structured `smartbot.json` profiles alongside legacy `.env` profiles.
- Added OpenRouter API-key agent support with configurable model and
  OpenAI-compatible base URL, while retaining Codex and Claude CLI auth.
- Kept Microsoft Minecraft device-code auth available from structured profiles.
- Integrated Microsoft device-code prompts into the desktop with a QR,
  copy-code, and open-page flow, plus GUI provider/model selection.
- Added a first-run **Create new runtime** setup that saves and selects a
  private structured profile when no existing profile is available.
- Added desktop Memory and Settings sections with bounded read-only summaries,
  provider/profile status, and connection controls.
- Added a Missions AI authoring panel that drafts strict MissionScript JSON,
  understands compiler limits and unsafe operations, and keeps apply/preview/
  save/run actions explicit in the editor.
- Added bounded, read-only map and memory context to Mission AI requests when
  relevant, while retaining the existing Codex, Claude, and OpenRouter paths.
- Added provider-neutral Mission AI IPC validation and focused context, parser,
  and authorization tests.

## 0.1.0-beta.1 — 2026-08-14

First supervised beta release candidate.

### Highlights

- Selectable Codex-subscription and Anthropic agent providers behind a curated,
  policy-checked Minecraft tool boundary.
- A macOS Electron control center with connection management, telemetry, logs,
  world map, MissionScript editing/runs, transaction history, and emergency stop.
- Durable tasks, construction, MissionScript materialization, SQLite restart
  recovery, role enforcement, world-change budgets, and conflict-aware undo.
- Bounded BuildOps/ASCII construction compilation and verified stateful stair
  placement.
- Modern Mineflayer compatibility for Minecraft 1.21.4+ player-loaded and
  tick-end packets, plus shared 1.19+ interaction sequences.
- A disposable Paper 1.21.4 integration gate covering real placement, digging,
  clearing, cancellation, construction, missions, permissions, undo, and SQLite
  reopen reconciliation.

### Release-blocker fixes

- Normalized Codex dynamic-tool JSON Schema so nested BuildOps unions are
  accepted by `codex app-server` without weakening runtime Zod validation.
- Added a safe persistent Mission draft and usable default example.
- Removed the World map drag callback race that could dereference a cleared
  pointer anchor.

### Known limitations

- macOS artifacts are arm64, ad-hoc signed, and not notarized.
- Supervised beta only; server plugins and permissions can alter behavior.
- See [the Beta 0.1 release record](docs/releases/0.1.0-beta.1.md) for the full
  validation matrix and operational limitations.
