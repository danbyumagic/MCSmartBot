# MCSmartBot

MCSmartBot is a goal-driven Minecraft Java companion bot built on Mineflayer. It combines model-driven planning with a curated TypeScript skill layer, SQLite-backed persistent state, durable tasks, and reactive safety behavior.

The first stable release is intentionally **headless**. Experimental desktop/control-panel work and proactive combat features are developed privately and are not part of v0.1.

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
- a supported Minecraft Java server;
- Codex CLI, Claude Code CLI, or an OpenRouter API key;
- a Microsoft Minecraft account for online-mode authentication, or an offline development server.

## Run from source

```bash
git clone https://github.com/danbyumagic/MCSmartBot.git
cd MCSmartBot
npm install
cp .env.example .env
cp server.example.json server.json
npm start
```

Never commit provider credentials, private runtime profiles, server-specific configuration, or authentication caches.

## Validate

```bash
npm run typecheck
npm test
npm run build
npm run release:headless
```

Read [SECURITY.md](SECURITY.md) before deployment. Third-party dependencies and reviewed upstream references are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `docs/upstream-reuse.json`.

MCSmartBot is an independent community project and is not affiliated with or endorsed by Mojang, Microsoft, Anthropic, OpenAI, or OpenRouter.
