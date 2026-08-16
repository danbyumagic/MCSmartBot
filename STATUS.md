# SmartBotMC project status

SmartBotMC is preparing its first stable public release as a **headless Minecraft
agent runtime**. The `release/v0.1.0` branch is the release-candidate line; the
exact tagged commit and attached headless tarball will define the supported
v0.1 surface.

## v0.1 scope

Included in the stable headless distribution:

- Mineflayer-based Minecraft Java connection and runtime lifecycle;
- Codex, Claude, and OpenRouter reasoning-provider adapters;
- curated structured tools for navigation, inventory, resources, crafting,
  smelting, farming, construction, memory, events, missions, and durable tasks;
- SQLite-backed persistent memory and restart-safe work state;
- role/capability checks and journaled world mutations where supported;
- reactive safety behavior such as auto-eating, low-health escape, lava
  avoidance, and self-protection;
- CLI operation, reconnect supervision, graceful shutdown, and instance locks.

Deferred from v0.1:

- Electron desktop/control-center distribution;
- additional dashboard development (the legacy dashboard is disabled by
  default in the release configuration);
- proactive combat skills and the divergent `feat/dashboard-and-combat` branch;
- MCP expansion and other new feature work.

## Release gates

A stable tag is blocked until all of the following are complete:

1. production dependency audit has no high/critical release-blocking advisory;
2. TypeScript release checks pass;
3. the headless automated test gate passes;
4. the reproducible headless tarball builds successfully;
5. a clean production install succeeds from the generated archive itself;
6. the archive contains no Electron/desktop UI or proactive combat payload;
7. the exact archive passes a controlled live-server smoke test;
8. current-tree and Git-history public-release audits are complete.

The detailed working checklist is tracked in GitHub issue #4.

## Known release considerations

- Microsoft authentication depends on Mineflayer's authentication chain. The
  current production audit reports a documented moderate transitive `uuid`
  advisory for which npm reports no compatible upstream fix; high/critical
  production findings remain release blockers.
- `better-sqlite3` is a native dependency. The release test harness is being
  hardened against native-module worker teardown behavior seen in CI while the
  application/runtime tests themselves remain unchanged.
- Minecraft server plugins, permissions, chat formats, anti-cheat behavior, and
  network conditions are outside SmartBotMC's trust boundary and can affect
  live behavior independently of the bot.
- v0.1 is intended for supervised use. New capabilities should be validated on
  a controlled server before unattended operation.

## Versioning

The package remains on the current prerelease version until the release
candidate passes manual acceptance. Only then will the release commit be bumped
to `0.1.0`, merged to `master`, tagged `v0.1.0`, and published with its matching
headless archive and SHA-256 checksum.
