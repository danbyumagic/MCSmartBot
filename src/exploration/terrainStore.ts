import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { DB } from "../memory/db.js";

export const TERRAIN_SAMPLE_SIZE = 2;

export interface TerrainSample {
  x: number;
  y: number;
  z: number;
  blockName: string;
}

export function recordTerrainSamples(
  db: DB,
  serverKey: string,
  dimension: string,
  samples: TerrainSample[],
  now = Date.now(),
): number {
  if (samples.length === 0) return 0;
  const write = db.transaction(() => {
    const statement = db.prepare(
      `INSERT INTO map_terrain_samples
         (server_key, dimension, x, z, y, block_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_key, dimension, x, z) DO UPDATE SET
         y = excluded.y,
         block_name = excluded.block_name,
         updated_at = excluded.updated_at`,
    );
    for (const sample of samples) {
      statement.run(
        serverKey, dimension, sample.x, sample.z, sample.y,
        sample.blockName, now,
      );
    }
    return samples.length;
  });
  return write();
}

export function createTerrainRecorder(deps: {
  bot: Bot;
  db: DB;
  serverKey: string;
}): { start(): void; stop(): void } {
  const queue: Array<{ chunkX: number; chunkZ: number }> = [];
  const queued = new Set<string>();
  let running = false;
  let stopped = false;
  let started = false;

  const enqueue = (chunkX: number, chunkZ: number) => {
    const key = `${deps.bot.game?.dimension ?? "unknown"}:${chunkX}:${chunkZ}`;
    if (queued.has(key) || stopped) return;
    queued.add(key);
    queue.push({ chunkX, chunkZ });
    if (!running) setImmediate(processNext);
  };
  const onChunk = (corner: Vec3) => enqueue(Math.floor(corner.x / 16), Math.floor(corner.z / 16));

  function processNext(): void {
    if (stopped || running) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    try {
      scanChunk(next.chunkX, next.chunkZ);
    } finally {
      running = false;
      if (queue.length > 0 && !stopped) setImmediate(processNext);
    }
  }

  function scanChunk(chunkX: number, chunkZ: number): void {
    const column = deps.bot.world.getColumn(chunkX, chunkZ) as unknown as {
      minY?: number;
      worldHeight?: number;
      getBlockType(position: Vec3): number;
    } | undefined;
    if (!column) return;
    const minY = column.minY ?? -64;
    const maxY = minY + (column.worldHeight ?? 384) - 1;
    const samples: TerrainSample[] = [];
    for (let localX = 0; localX < 16; localX += TERRAIN_SAMPLE_SIZE) {
      for (let localZ = 0; localZ < 16; localZ += TERRAIN_SAMPLE_SIZE) {
        for (let y = maxY; y >= minY; y -= 1) {
          const type = column.getBlockType(new Vec3(localX, y, localZ));
          const name = deps.bot.registry.blocks[type]?.name;
          if (!name || name === "air" || name === "cave_air" || name === "void_air") continue;
          samples.push({
            x: chunkX * 16 + localX,
            y,
            z: chunkZ * 16 + localZ,
            blockName: name,
          });
          break;
        }
      }
    }
    recordTerrainSamples(
      deps.db,
      deps.serverKey,
      deps.bot.game?.dimension ?? "unknown",
      samples,
    );
  }

  return {
    start() {
      if (started || !deps.bot.world) return;
      started = true;
      stopped = false;
      deps.bot.world.on("chunkColumnLoad", onChunk);
      for (const entry of deps.bot.world.getColumns()) {
        enqueue(Number(entry.chunkX), Number(entry.chunkZ));
      }
    },
    stop() {
      stopped = true;
      queue.length = 0;
      if (started && deps.bot.world) {
        deps.bot.world.removeListener("chunkColumnLoad", onChunk);
      }
      started = false;
    },
  };
}
