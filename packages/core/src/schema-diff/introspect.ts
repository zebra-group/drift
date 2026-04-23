import type { Pool, RowDataPacket } from "mysql2/promise";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  extra: string;
  collation: string | null;
  comment: string;
  ordinalPosition: number;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  type: string;
}

export interface TableInfo {
  name: string;
  engine: string | null;
  collation: string | null;
  comment: string;
  createStatement: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKey: string[];
}

export interface RoutineInfo {
  name: string;
  kind: "PROCEDURE" | "FUNCTION";
  definition: string;
}

export interface ViewInfo {
  name: string;
  definition: string;
}

export interface TriggerInfo {
  name: string;
  definition: string;
}

export interface SchemaSnapshot {
  database: string;
  tables: Map<string, TableInfo>;
  views: Map<string, ViewInfo>;
  routines: Map<string, RoutineInfo>;
  triggers: Map<string, TriggerInfo>;
}

async function q<T extends RowDataPacket>(pool: Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql, params);
  return rows;
}

export async function introspect(pool: Pool, database: string): Promise<SchemaSnapshot> {
  const snap: SchemaSnapshot = {
    database,
    tables: new Map(),
    views: new Map(),
    routines: new Map(),
    triggers: new Map(),
  };

  const tableRows = await q<RowDataPacket & { TABLE_NAME: string; ENGINE: string | null; TABLE_COLLATION: string | null; TABLE_COMMENT: string; TABLE_TYPE: string }>(
    pool,
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT, TABLE_TYPE
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [database],
  );

  for (const row of tableRows) {
    if (row.TABLE_TYPE === "VIEW") continue;
    const [createRows] = await pool.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${database}\`.\`${row.TABLE_NAME}\``);
    const createStatement = String(createRows[0]?.["Create Table"] ?? "");

    const columns = await q<RowDataPacket & {
      COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null; EXTRA: string; COLLATION_NAME: string | null;
      COLUMN_COMMENT: string; ORDINAL_POSITION: number;
    }>(
      pool,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
              COLLATION_NAME, COLUMN_COMMENT, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, row.TABLE_NAME],
    );

    const indexRows = await q<RowDataPacket & {
      INDEX_NAME: string; NON_UNIQUE: number; COLUMN_NAME: string;
      SEQ_IN_INDEX: number; INDEX_TYPE: string;
    }>(
      pool,
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, row.TABLE_NAME],
    );

    const idxMap = new Map<string, IndexInfo>();
    for (const r of indexRows) {
      let idx = idxMap.get(r.INDEX_NAME);
      if (!idx) {
        idx = { name: r.INDEX_NAME, unique: r.NON_UNIQUE === 0, columns: [], type: r.INDEX_TYPE };
        idxMap.set(r.INDEX_NAME, idx);
      }
      idx.columns.push(r.COLUMN_NAME);
    }
    const primaryKey = idxMap.get("PRIMARY")?.columns ?? [];

    snap.tables.set(row.TABLE_NAME, {
      name: row.TABLE_NAME,
      engine: row.ENGINE,
      collation: row.TABLE_COLLATION,
      comment: row.TABLE_COMMENT,
      createStatement,
      columns: columns.map((c) => ({
        name: c.COLUMN_NAME,
        type: c.COLUMN_TYPE,
        nullable: c.IS_NULLABLE === "YES",
        default: c.COLUMN_DEFAULT,
        extra: c.EXTRA,
        collation: c.COLLATION_NAME,
        comment: c.COLUMN_COMMENT,
        ordinalPosition: c.ORDINAL_POSITION,
      })),
      indexes: Array.from(idxMap.values()),
      primaryKey,
    });
  }

  const viewRows = await q<RowDataPacket & { TABLE_NAME: string }>(
    pool,
    `SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
    [database],
  );
  for (const v of viewRows) {
    const [createRows] = await pool.query<RowDataPacket[]>(`SHOW CREATE VIEW \`${database}\`.\`${v.TABLE_NAME}\``);
    snap.views.set(v.TABLE_NAME, {
      name: v.TABLE_NAME,
      definition: String(createRows[0]?.["Create View"] ?? ""),
    });
  }

  const routineRows = await q<RowDataPacket & { ROUTINE_NAME: string; ROUTINE_TYPE: string }>(
    pool,
    `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
    [database],
  );
  for (const r of routineRows) {
    const kind = r.ROUTINE_TYPE.toUpperCase() as "PROCEDURE" | "FUNCTION";
    const [createRows] = await pool.query<RowDataPacket[]>(`SHOW CREATE ${kind} \`${database}\`.\`${r.ROUTINE_NAME}\``);
    const col = kind === "PROCEDURE" ? "Create Procedure" : "Create Function";
    snap.routines.set(`${kind}:${r.ROUTINE_NAME}`, {
      name: r.ROUTINE_NAME,
      kind,
      definition: String(createRows[0]?.[col] ?? ""),
    });
  }

  const triggerRows = await q<RowDataPacket & { TRIGGER_NAME: string }>(
    pool,
    `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
    [database],
  );
  for (const t of triggerRows) {
    const [createRows] = await pool.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${database}\`.\`${t.TRIGGER_NAME}\``);
    snap.triggers.set(t.TRIGGER_NAME, {
      name: t.TRIGGER_NAME,
      definition: String(createRows[0]?.["SQL Original Statement"] ?? createRows[0]?.["Statement"] ?? ""),
    });
  }

  return snap;
}
