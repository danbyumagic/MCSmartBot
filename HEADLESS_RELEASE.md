# MCSmartBot v0.1 headless release

This document describes the supported headless distribution for the MCSmartBot v0.1 release line. The archive contains the compiled CLI/runtime, configuration examples, dependency lockfile, database schema, security and license notices, and the files required to run the bot without the experimental desktop/control-panel surface.

## v0.1 scope

The v0.1 public release intentionally excludes experimental desktop/control-panel code and proactive combat skills. Reactive escape and self-protection remain part of the safety layer. The packaged `.env.example` starts with the legacy dashboard compatibility surface disabled.

The public `main` branch and the versioned release archive define the supported v0.1 surface.

## Install

Requirements:

- Node.js 22.12 or newer
- A compatible Minecraft Java server
- One supported reasoning provider configured and authenticated: Codex CLI, Claude Code CLI, or OpenRouter

Extract the archive and install the locked production dependencies:

```bash
npm ci --omit=dev
cp .env.example .env
cp server.example.json server.json
```

Edit `.env` and, when needed, `server.json`, then start MCSmartBot:

```bash
npm start
```

The archive's `npm start` runs the compiled JavaScript entry point directly. TypeScript and other development tooling are not required at runtime.

## Persistent state

Runtime state belongs outside the release artifact. By default it is stored under `./data`; keep that directory when upgrading so SQLite memory and cached Minecraft authentication survive replacement of the application files.

Never publish `.env`, `smartbot.json`, private `server.json` files, `data/`, provider credentials, or authentication caches.

## Verification

The release builder fails if deferred desktop or proactive-combat payload appears in the staged archive. It also writes a matching `.sha256` file beside the tarball.

Before a release is published, CI extracts the exact archive, installs production dependencies with `npm ci --omit=dev`, checks the compiled entry point, confirms the dashboard example setting is disabled, and verifies the deferred directories are absent.

When transferring an archive between machines, verify its SHA-256 checksum before installation.
