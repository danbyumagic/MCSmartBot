# Third-party reuse notices

SmartBotMC may include modified portions of the pinned upstream sources listed
below. Each adaptation is recorded in
[`docs/upstream-reuse.json`](docs/upstream-reuse.json), which maps the exact
repository snapshot and source paths to its local destination. The manifest is
the authoritative machine-readable record; an empty `adaptedPaths` list means
that no code from that source has been adapted yet.

Adapted files retain an adjacent source header naming the repository, pinned
commit, upstream path, license, and the fact that the file was modified for
SmartBotMC. This project does not imply endorsement by any upstream author.

| Source | Pinned snapshot | Local license | Intended SmartBotMC destination |
| --- | --- | --- | --- |
| [mineflayer](https://github.com/PrismarineJS/mineflayer) | `4a2e160a39d48a9817e7a9c1c320b12e3b495fad` | [MIT](LICENSES/mineflayer-MIT.txt) | `src/bot/clientTickEnd.ts` modern tick-end, interaction-sequence, and player-loaded compatibility |
| [minecraft-agentic](https://github.com/NoblerWorks-HQ/minecraft-agentic) | `7e2590d9150e47956371e610e1f3ac050d3f7ad2` | [MIT](LICENSES/minecraft-agentic-MIT.txt) | `src/construction/buildOps/canvas.ts`, `src/construction/buildOps/compiler.ts`, and their focused translated tests |
| [cobble-mcp](https://github.com/brian-mwirigi/cobble-mcp) | `47edea1a9cc965776c578d66d24233bc9563dd2f` | [MIT](LICENSES/cobble-mcp-MIT.txt) | `src/construction/buildOps/ascii.ts` |
| [mc-architect-mcp](https://github.com/AnctyEnly453/mc-architect-mcp) | `51fe736bf4bf59185f961e80f01b58c36b67f7fa` | [MIT](LICENSES/mc-architect-mcp-MIT.txt) | `src/construction/buildOps/geometry.ts` |
| [minecraft-mcp-server (AhmadTariq1337)](https://github.com/AhmadTariq1337/minecraft-mcp-server) | `39ab7c3a3d5cb1f6262fba080858b083647e650a` | [MIT](LICENSES/ahmad-minecraft-mcp-MIT.txt) | `src/skills/combat/attackMob.ts`, `src/skills/interaction/openVillager.ts`, and `src/skills/interaction/tradeVillager.ts` |
| [minecraft-mcp-server (yuniko-software)](https://github.com/yuniko-software/minecraft-mcp-server) | `240c8cec337ce152cc9e058ebdef511055808406` | [Apache-2.0](LICENSES/yuniko-minecraft-mcp-Apache-2.0.txt) | `src/world/` verified block executor |
| [mc-multimodal-agent](https://github.com/win10ogod/mc-multimodal-agent) | `8d1b9dc62d5a9e99aa2b33fd50fe19ee2b920f0e` | [Apache-2.0](LICENSES/mc-multimodal-agent-Apache-2.0.txt) | `src/missions/schema.ts` and `tests/missions/schema.test.ts` |

Sources listed under `referenceOnly` in the manifest are not imported. In
particular, AGPL-licensed or unlicensed source does not enter SmartBotMC.

The current Yuniko-derived adaptation is limited to
[`src/world/reach.ts`](src/world/reach.ts) and
[`src/world/blockExecutor.ts`](src/world/blockExecutor.ts). Immutable snapshot
and persistence-facing types are SmartBotMC-authored rather than copied or
translated from upstream.
