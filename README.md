# MCSmartBot

MCSmartBot is a goal-driven Minecraft Java companion bot built on Mineflayer. It combines model-driven planning with a curated TypeScript skill layer, SQLite-backed persistent state, durable tasks, and reactive safety behavior.

The first stable release is intentionally **headless**. Experimental desktop/dashboard work and proactive combat features remain in the private development repository and are not part of v0.1.

## What v0.1 does

MCSmartBot connects a Minecraft client to a reasoning provider and exposes a bounded set of game capabilities as structured tools. The agent can observe state, plan work, call those tools, persist useful information, and resume durable work across restarts.

Core capabilities include:

- natural-language instructions through Minecraft chat and a local CLI;
- navigation, following, resource gathering, inventory, and containers;
- crafting, smelting, equipment selection, farming, and bounded construction;
- durable task plans, supply goals, and scheduled work;
- persistent facts, locations, goals, observations, and task history in SQLite;
- structured missions and journaled world changes with conflict-aware undo;
- reactive auto-eating, low-health escape, lava avoidance, and self-protection;
- reconnect supervision, single-instance locking, roles, and event handling;
- selectable Codex, Claude, or OpenRouter reasoning adapters.

## Requirements

- Node.js 22.12 or newer.
- A reachable Minecraft Java server supported by the configured Mineflayer protocol version.
- One supported reasoning-provider path: Codex CLI, Claude Code CLI, or OpenRouter.
- A Microsoft Minecraft account for `BOT_AUTH=microsoft`, or an offline-mode development server for `BOT_AUTH=offline`.

## Running from source

```bash
git clone https://github.com/danbyumagic/MCSmartBot.git
cd MCSmartBot
npm ci
cp .env.example .env
cp server.example.json server.json
npm start
```

Local configuration and runtime state are intentionally ignored by Git.

## Provider configuration

The example configuration defaults to Codex:

```dotenv
AGENT_PROVIDER=codex
```

To use Claude Code instead:

```dotenv
AGENT_PROVIDER=anthropic
```

To use OpenRouter:

```dotenv
AGENT_PROVIDER=openrouter
AGENT_API_KEY=your-key-here
AGENT_MODEL=openai/gpt-4o-mini
```

Never commit provider credentials, private profiles, server-specific configuration, or authentication caches.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run release:headless
```

The release pipeline builds a headless artifact from an allowlisted staging surface and rejects deferred desktop/combat payload from the archive.

## Project layout

- `src/agent/` — provider adapters, prompts, and structured agent tools;
- `src/skills/` — executable Minecraft capabilities;
- `src/tasks/`, `src/supply/`, `src/farming/` — durable work and schedulers;
- `src/construction/` — bounded construction and BuildOps machinery;
- `src/missions/` — validated mission definitions and durable mission runs;
- `src/memory/` — SQLite schema and persistent state;
- `src/reactive/` — high-priority safety reflexes and preemption;
- `src/runtime/` — connection lifecycle, reconnects, and instance locking;
- `tests/` — automated tests.

## Security and third-party work

Read [SECURITY.md](SECURITY.md) before deployment. Third-party dependencies and reviewed upstream references are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `docs/upstream-reuse.json`.

MCSmartBot is an independent community project and is not affiliated with or endorsed by Mojang, Microsoft, Anthropic, OpenAI, or OpenRouter.
