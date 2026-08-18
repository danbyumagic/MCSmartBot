# MCSmartBot

A goal-driven Minecraft Java companion bot built on Mineflayer. MCSmartBot pairs a
configurable reasoning provider (Codex, Claude, or OpenRouter) with a curated
TypeScript skill layer, SQLite-backed persistent memory, durable task planning,
and reactive safety behavior.

[![CI](https://github.com/danbyumagic/MCSmartBot/actions/workflows/ci.yml/badge.svg)](https://github.com/danbyumagic/MCSmartBot/actions/workflows/ci.yml)

## What v0.1 is

MCSmartBot connects a Minecraft client to a reasoning provider and exposes a
bounded set of game capabilities as structured tools. The agent can observe
world state, plan work, call those tools, persist useful information, and resume
durable work across restarts.

The first public release is intentionally **headless**: it ships as a CLI/runtime
with no experimental desktop/control-center surface. Reactive escape and
self-protection remain part of the safety layer. See
[HEADLESS_RELEASE.md](HEADLESS_RELEASE.md) for the exact artifact boundary and
[STATUS.md](STATUS.md) for the current release gates.

The `main` branch is the supported public source line. Experimental work is
reviewed against the public release boundary before it is promoted here, so the
repository stays focused on code and documentation that are intended to ship.

## Core v0.1 capabilities

- natural-language instructions through Minecraft chat and a local CLI;
- navigation, following, resource gathering, inventory, and containers;
- crafting, smelting, equipment selection, farming, and bounded construction;
- durable task plans, supply goals, scheduled work, and structured missions;
- persistent facts, locations, goals, observations, and task history in SQLite;
- journaled world changes with conflict-aware undo;
- reactive auto-eating, low-health escape, lava avoidance, and self-protection;
- reconnect supervision, single-instance locking, roles, and event handling;
- selectable Codex, Claude, or OpenRouter reasoning adapters.

## Requirements

- Node.js 22.12 or newer;
- a reachable Minecraft Java server compatible with the configured Mineflayer
  protocol version (verified profiles target Paper/Spigot 1.21.x);
- one supported reasoning provider (see [Provider configuration](#provider-configuration));
- a Microsoft Minecraft account for online-mode authentication, or an offline
  development server for `BOT_AUTH=offline`.

## Running from source

```bash
git clone https://github.com/danbyumagic/MCSmartBot.git
cd MCSmartBot
npm ci
cp .env.example .env
cp server.example.json server.json
npm start
```

Edit `.env` (and, when needed, `server.json`) before starting. Configuration and
runtime state are intentionally ignored by Git.

## Provider configuration

The example configuration defaults to Codex, which reuses an existing ChatGPT
`codex login`:

```dotenv
AGENT_PROVIDER=codex
```

Confirm the login MCSmartBot will reuse:

```bash
codex login status
```

To use Claude Code instead:

```dotenv
AGENT_PROVIDER=anthropic
```

To use OpenRouter with an API key:

```dotenv
AGENT_PROVIDER=openrouter
AGENT_API_KEY=your-key-here
AGENT_MODEL=openai/gpt-4o-mini
```

Never commit provider credentials, private profiles, or authentication caches.

## Local CLI

While MCSmartBot is running:

- plain text sends public Minecraft chat;
- `ask <instruction>` sends a natural-language instruction to the agent;
- `/<command>` sends a Minecraft server command;
- `status` prints current runtime state;
- `quit` or `exit` requests graceful shutdown.

## Persistent state

Runtime state is stored under `./data` by default. Keep that directory when
upgrading so SQLite memory and cached Minecraft authentication survive
replacement of the application files.

Do not publish `.env`, `smartbot.json`, private `server.json` files, `data/`,
provider credentials, or authentication caches.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run release:headless
```

CI runs the same gate on every push to `main` and pull request, then extracts and
verifies the exact headless archive: checksum match, production-only install, and
no desktop or proactive-combat payload. Read [SECURITY.md](SECURITY.md) before
deployment.

## Release policy

`main` is the main source line. Tagged releases define stable versions; for v0.1
the headless tarball is the supported distribution surface. Development code can
exist in the repository without being included in a stable artifact. Known
limitations belong in release notes rather than hidden behind silent retries.

## Project layout

- `src/agent/` — provider adapters, prompts, and structured agent tools;
- `src/skills/` — executable Minecraft capabilities;
- `src/tasks/`, `src/supply/`, `src/farming/` — durable work and schedulers;
- `src/construction/` — bounded construction and BuildOps machinery;
- `src/missions/` — validated mission definitions and durable mission runs;
- `src/memory/` — SQLite schema and persistent state;
- `src/reactive/` — high-priority safety reflexes and preemption;
- `src/runtime/` — connection lifecycle, reconnects, and instance locking;
- `src/permissions/`, `src/exploration/` — role checks and world observations;
- `src/cli/`, `src/bot/` — interactive commands and chat integration;
- `tests/` — release and integration tests;
- `docs/` — design records and upstream-reuse provenance.

## Security and third-party work

Read [SECURITY.md](SECURITY.md) before deployment. Third-party dependencies and
reviewed upstream references are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `docs/upstream-reuse.json`.
See [CHANGELOG.md](CHANGELOG.md) for release history.

MCSmartBot is an independent community project and is not affiliated with or
endorsed by Mojang, Microsoft, Anthropic, OpenAI, or OpenRouter.
