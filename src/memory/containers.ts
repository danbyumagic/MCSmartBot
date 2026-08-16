import type { DB } from "./db.js";

export interface ContainerSnapshotItem {
  item: string;
  itemType: number;
  metadata: number;
  count: number;
}

export interface ContainerSnapshotInput {
  name: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  blockType: string;
  items: ContainerSnapshotItem[];
}

export interface ContainerRow {
  id: number;
  name: string;
  tsScanned: number;
  dimension: string;
  x: number;
  y: number;
  z: number;
  blockType: string;
}

export interface IndexedContainerItem extends ContainerRow {
  item: string;
  itemType: number;
  metadata: number;
  count: number;
}

export function replaceContainerSnapshot(db: DB, input: ContainerSnapshotInput): ContainerRow {
  const write = db.transaction(() => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO containers (name, ts_scanned, dimension, x, y, z, block_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ts_scanned = excluded.ts_scanned,
         dimension = excluded.dimension,
         x = excluded.x,
         y = excluded.y,
         z = excluded.z,
         block_type = excluded.block_type`,
    ).run(input.name, ts, input.dimension, input.x, input.y, input.z, input.blockType);

    const container = getContainer(db, input.name);
    if (!container) throw new Error(`container '${input.name}' missing after upsert`);
    db.prepare("DELETE FROM container_items WHERE container_id = ?").run(container.id);
    const insert = db.prepare(
      `INSERT INTO container_items (container_id, item, item_type, metadata, count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(container_id, item, metadata) DO UPDATE SET
         count = container_items.count + excluded.count`,
    );
    for (const item of input.items) {
      if (item.count <= 0) continue;
      insert.run(container.id, item.item, item.itemType, item.metadata, item.count);
    }
    return container;
  });
  return write();
}

export function getContainer(db: DB, name: string): ContainerRow | undefined {
  const row = db.prepare(
    `SELECT id, name, ts_scanned, dimension, x, y, z, block_type
     FROM containers WHERE name = ?`,
  ).get(name) as {
    id: number;
    name: string;
    ts_scanned: number;
    dimension: string;
    x: number;
    y: number;
    z: number;
    block_type: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    tsScanned: row.ts_scanned,
    dimension: row.dimension,
    x: row.x,
    y: row.y,
    z: row.z,
    blockType: row.block_type,
  };
}

export function getContainerItems(db: DB, name: string): ContainerSnapshotItem[] {
  return db.prepare(
    `SELECT ci.item, ci.item_type, ci.metadata, ci.count
     FROM container_items ci
     JOIN containers c ON c.id = ci.container_id
     WHERE c.name = ?
     ORDER BY ci.item ASC, ci.metadata ASC`,
  ).all(name).map((row) => {
    const r = row as { item: string; item_type: number; metadata: number; count: number };
    return { item: r.item, itemType: r.item_type, metadata: r.metadata, count: r.count };
  });
}

export function findContainersWithItem(db: DB, item: string): IndexedContainerItem[] {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.ts_scanned, c.dimension, c.x, c.y, c.z, c.block_type,
            ci.item, ci.item_type, ci.metadata, ci.count
     FROM container_items ci
     JOIN containers c ON c.id = ci.container_id
     WHERE ci.item = ? AND ci.count > 0
     ORDER BY c.ts_scanned DESC, c.name ASC`,
  ).all(item) as Array<{
    id: number;
    name: string;
    ts_scanned: number;
    dimension: string;
    x: number;
    y: number;
    z: number;
    block_type: string;
    item: string;
    item_type: number;
    metadata: number;
    count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tsScanned: r.ts_scanned,
    dimension: r.dimension,
    x: r.x,
    y: r.y,
    z: r.z,
    blockType: r.block_type,
    item: r.item,
    itemType: r.item_type,
    metadata: r.metadata,
    count: r.count,
  }));
}
