# Security policy

SmartBotMC 0.1 is being prepared as a public headless release. Security support
applies to the latest tagged 0.1.x release; development branches and experimental
desktop UI are not stable release surfaces.

## Reporting

Please report suspected vulnerabilities privately to the repository owner with
the affected version, reproduction steps, impact, and relevant logs with tokens
removed. Do not post credentials, private server addresses, player data, OAuth
tokens, API keys, or a working exploit in a public issue.

## Security boundaries

- Keep `.env`, `.env.local`, `smartbot.json`, private `server.json` files,
  `data/`, Microsoft OAuth caches, provider API keys, and Codex/Claude
  credentials out of Git and release archives.
- The v0.1 headless artifact starts with the dashboard disabled. If the legacy
  dashboard is enabled manually, keep it bound to loopback unless it is placed
  behind an authenticated reverse proxy.
- Agent providers receive only curated SmartBotMC tools. Role and capability
  checks are repeated at direct and durable execution boundaries.
- World mutation is journaled and verified where supported, but server plugins,
  anti-cheat systems, network infrastructure, and other players remain outside
  SmartBotMC's trust boundary.
- Use a controlled test server and a least-privilege bot account when validating
  a release candidate or an unfamiliar plugin/server configuration.
- The experimental Electron control-center source may exist in the repository,
  but it is not shipped in the v0.1 headless release artifact.

## Dependency policy

The release gate checks production dependencies separately from development and
desktop packaging dependencies. A v0.1 tag must not knowingly ship a high or
critical production advisory without an explicit documented exception.

The current accepted production exception is the moderate `uuid` advisory in
Mineflayer's Microsoft-authentication dependency chain (`GHSA-w5hq-g745-h8pq`),
for which npm has reported no compatible upstream fix in the verified beta
baseline. Recheck the production dependency graph before tagging a release and
do not use `npm audit fix --force` as a release step.

## Release verification

The supported v0.1 distribution is the tagged headless tarball. Release builds
produce an adjacent SHA-256 checksum and reject Electron/desktop payload in the
staged archive. The final artifact must also pass a clean-install and controlled
live-server smoke test before publication.
