# SmartBotMC v0.1 headless release

This archive is the supported headless distribution for SmartBotMC v0.1. It
contains the compiled CLI/runtime, configuration examples, database schema,
license notices, and the files required to run the bot without the Electron
control-center UI.

## Deferred from v0.1

- The divergent `feat/dashboard-and-combat` branch is not merged into this
  release line.
- Electron desktop/control-center panels and their packaging assets are not
  included in the headless tarball.
- Dashboard work beyond the existing legacy compatibility surface is deferred.
  The packaged `.env.example` starts with the dashboard disabled.
- Proactive combat skills (`huntAnimals`, `attackMob`, and `attackPlayer`) are
  stripped from the compiled v0.1 headless runtime and the combat skill module
  directory is omitted from the archive.
- Reactive escape and self-protection remain part of the safety layer.

The source repository may contain development work that is intentionally absent
from this release artifact. The release tag and tarball define the v0.1 stable
surface.

## Install

Requirements:

- Node.js 22.12 or newer
- A compatible Minecraft Java server
- One supported reasoning provider configured and authenticated: Codex CLI,
  Claude Code CLI, or OpenRouter

Extract the archive and install production dependencies:

```bash
npm ci --omit=dev
cp .env.example .env
cp server.example.json server.json
```

Edit `.env` and, when needed, `server.json`, then start SmartBotMC:

```bash
npm start
```

The archive's `npm start` runs the compiled JavaScript entry point directly;
TypeScript, Electron, Vite, and other development tooling are not required at
runtime.

## Persistent state

Runtime state belongs outside the release artifact. By default it is stored
under `./data`; keep that directory when upgrading so SQLite memory and cached
Minecraft authentication survive replacement of the application files.

Never publish `.env`, `smartbot.json`, private `server.json` files, `data/`,
provider credentials, or authentication caches.

## Verification

The release builder rejects Electron/desktop payload and proactive combat skill
payload in the staged archive. It also produces a matching `.sha256` file beside
the tarball. Verify the checksum before installing when the archive was
transferred between machines.
