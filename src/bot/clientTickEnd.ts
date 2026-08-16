// Behavior adapted from PrismarineJS/mineflayer,
// lib/plugins/{physics,generic_place,inventory}.js
// @ 4a2e160a39d48a9817e7a9c1c320b12e3b495fad.
// Licensed under MIT; see LICENSES/mineflayer-MIT.txt.
// Modified by SmartBotMC: runtime-scoped compatibility install, automatic
// upstream-send detection, shared modern interaction sequencing, and reversible
// teardown instead of patching a dependency. SmartBotMC also adds the 1.21.4+
// player-loaded acknowledgement, which is absent from the pinned Mineflayer.

type ClientWrite = (name: string, payload: Record<string, unknown>) => unknown;

export interface ClientTickEndBot {
  readonly protocolVersion: string | number;
  supportFeature(name: string): string | number | boolean;
  on(event: "physicsTick" | "spawn", listener: () => void): unknown;
  removeListener(event: "physicsTick" | "spawn", listener: () => void): unknown;
  readonly _client: {
    state?: string;
    write: ClientWrite;
  };
}

const installed = new WeakMap<object, () => void>();
const FIRST_SEQUENCE_PROTOCOL = 759; // Minecraft Java 1.19
const FIRST_PLAYER_LOADED_PROTOCOL = 769; // Minecraft Java 1.21.4
const SEQUENCED_INTERACTION_PACKETS = new Set(["block_dig", "block_place", "use_item"]);

function nextSignedInt32(value: number): number {
  return value === 0x7fffffff ? -0x80000000 : value + 1;
}

/**
 * Mineflayer 4.37.1 knows the modern `tick_end` packet but does not emit it.
 * Paper/vanilla 1.21.2+ may consequently ignore an otherwise valid use-item
 * packet, which makes verified placement time out with the target unchanged.
 *
 * Schedule the compatibility packet after Mineflayer's synchronous physics
 * tick. If a newer Mineflayer writes its own packet in the remainder of that
 * tick, the write counter changes and this shim deliberately emits nothing.
 */
export function installMineflayerProtocolCompatibility(bot: ClientTickEndBot): () => void {
  const existing = installed.get(bot);
  if (existing) return existing;

  const needsTickEnd = bot.supportFeature("sendsClientTickEndPacket") === true;
  const protocolVersion = Number(bot.protocolVersion);
  const needsInteractionSequence = Number.isInteger(protocolVersion) && protocolVersion >= FIRST_SEQUENCE_PROTOCOL;
  const needsPlayerLoaded = Number.isInteger(protocolVersion) && protocolVersion >= FIRST_PLAYER_LOADED_PROTOCOL;
  if (!needsTickEnd && !needsInteractionSequence && !needsPlayerLoaded) return () => undefined;

  const client = bot._client;
  const originalWrite = client.write;
  let tickEndWrites = 0;
  let playerLoadedWrites = 0;
  let playerLoadedWritesAtLastSpawn = 0;
  let interactionSequence = 0;
  let active = true;

  const observedWrite: ClientWrite = function observedClientWrite(name, payload) {
    if (name === "tick_end") tickEndWrites++;
    if (name === "player_loaded") playerLoadedWrites++;
    if (needsInteractionSequence && SEQUENCED_INTERACTION_PACKETS.has(name)) {
      interactionSequence = nextSignedInt32(interactionSequence);
      return Reflect.apply(originalWrite, client, [name, { ...payload, sequence: interactionSequence }]);
    }
    return Reflect.apply(originalWrite, client, [name, payload]);
  };
  client.write = observedWrite;

  const onPhysicsTick = (): void => {
    if (!needsTickEnd) return;
    const writesBeforeNativeTickEnd = tickEndWrites;
    queueMicrotask(() => {
      if (!active || client.state !== "play" || tickEndWrites !== writesBeforeNativeTickEnd) return;
      client.write("tick_end", {});
    });
  };
  bot.on("physicsTick", onPhysicsTick);

  const onSpawn = (): void => {
    if (!needsPlayerLoaded) return;
    const writesBeforeNativeAcknowledgement = playerLoadedWrites;
    if (writesBeforeNativeAcknowledgement > playerLoadedWritesAtLastSpawn) {
      playerLoadedWritesAtLastSpawn = writesBeforeNativeAcknowledgement;
      return;
    }
    queueMicrotask(() => {
      if (!active || client.state !== "play") return;
      if (playerLoadedWrites === writesBeforeNativeAcknowledgement) client.write("player_loaded", {});
      playerLoadedWritesAtLastSpawn = playerLoadedWrites;
    });
  };
  bot.on("spawn", onSpawn);

  const teardown = (): void => {
    if (!active) return;
    active = false;
    bot.removeListener("physicsTick", onPhysicsTick);
    bot.removeListener("spawn", onSpawn);
    if (client.write === observedWrite) client.write = originalWrite;
    installed.delete(bot);
  };
  installed.set(bot, teardown);
  return teardown;
}

/** @deprecated Use installMineflayerProtocolCompatibility for new call sites. */
export const installClientTickEndCompatibility = installMineflayerProtocolCompatibility;
