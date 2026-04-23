import type { ColumnInfo, IndexInfo, SchemaSnapshot, TableInfo } from "./introspect.js";

export interface SchemaStatement {
  kind:
    | "create-table" | "drop-table" | "alter-table"
    | "create-view" | "drop-view" | "alter-view"
    | "create-routine" | "drop-routine"
    | "create-trigger" | "drop-trigger";
  object: string;
  sql: string;
  destructive: boolean;
}

function qid(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

function columnDef(c: ColumnInfo): string {
  let s = `${qid(c.name)} ${c.type}`;
  if (c.collation) s += ` COLLATE ${c.collation}`;
  s += c.nullable ? " NULL" : " NOT NULL";
  if (c.default !== null) {
    const isExpr = /^(CURRENT_TIMESTAMP|NOW\(|[A-Z_]+\()/i.test(c.default);
    s += ` DEFAULT ${isExpr ? c.default : `'${c.default.replace(/'/g, "''")}'`}`;
  }
  // Strip MariaDB metadata flags that appear in information_schema but are not valid SQL
  const extra = c.extra.replace(/DEFAULT_GENERATED\s*/gi, "").trim();
  if (extra) s += ` ${extra}`;
  if (c.comment) s += ` COMMENT '${c.comment.replace(/'/g, "''")}'`;
  return s;
}

function normalizeExtra(e: string): string {
  return e.replace(/DEFAULT_GENERATED\s*/gi, "").trim().toLowerCase();
}

/**
 * MySQL 8 dropped integer display widths (int vs int(11)), MariaDB keeps them.
 * MariaDB has no native json type — it stores json columns as longtext.
 * Normalize so cross-version comparison is stable.
 */
function normalizeType(t: string): string {
  return t
    .replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/gi, "$1")
    .replace(/\bjson\b/gi, "longtext")
    .toLowerCase();
}

/**
 * MySQL always reports the effective collation; MariaDB may return null for
 * columns that inherit the table's collation. Treat null as a wildcard so we
 * don't generate endless MODIFY COLUMN statements for inherited collations.
 */
function collationsCompatible(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return true;
  return false;
}

/**
 * Compare defaults leniently across MySQL 8 and MariaDB:
 * - MySQL 8 stores JS null for DEFAULT NULL; MariaDB stores the string "NULL"
 * - MySQL 8 omits quotes on string defaults ("all"); MariaDB includes them ("'all'")
 * - MySQL 8 uses lowercase function names (current_timestamp()); MariaDB may uppercase or append "()"
 */
function defaultsEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  // MySQL null ≡ MariaDB "NULL"
  if (a === null && b === "NULL") return true;
  if (a === "NULL" && b === null) return true;
  if (a === null || b === null) return false;
  const norm = (s: string) => {
    let v = s.trim();
    // MariaDB wraps string defaults in single quotes in information_schema
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    return v.toLowerCase().replace(/\(\)$/, "");
  };
  return norm(a) === norm(b);
}

function columnsEqual(a: ColumnInfo, b: ColumnInfo, debugLog?: (msg: string) => void): boolean {
  const srcType = normalizeType(a.type), tgtType = normalizeType(b.type);
  if (srcType !== tgtType) { debugLog?.(`[col-diff] '${a.name}' type: ${a.type} → ${srcType}  vs  ${b.type} → ${tgtType}`); return false; }
  if (a.nullable !== b.nullable) { debugLog?.(`[col-diff] '${a.name}' nullable: ${a.nullable} vs ${b.nullable}`); return false; }
  if (!defaultsEqual(a.default, b.default)) { debugLog?.(`[col-diff] '${a.name}' default: ${JSON.stringify(a.default)} vs ${JSON.stringify(b.default)}`); return false; }
  const srcEx = normalizeExtra(a.extra), tgtEx = normalizeExtra(b.extra);
  if (srcEx !== tgtEx) { debugLog?.(`[col-diff] '${a.name}' extra: "${srcEx}" vs "${tgtEx}"`); return false; }
  if (!collationsCompatible(a.collation, b.collation)) { debugLog?.(`[col-diff] '${a.name}' collation: ${a.collation} vs ${b.collation}`); return false; }
  if (a.comment !== b.comment) { debugLog?.(`[col-diff] '${a.name}' comment: ${JSON.stringify(a.comment)} vs ${JSON.stringify(b.comment)}`); return false; }
  return true;
}

function indexSignature(i: IndexInfo): string {
  return `${i.unique ? "UNIQUE" : "INDEX"}:${i.columns.join(",")}`;
}

function diffTable(src: TableInfo, tgt: TableInfo, debugLog?: (msg: string) => void): SchemaStatement[] {
  const out: SchemaStatement[] = [];
  const srcCols = new Map(src.columns.map((c) => [c.name, c]));
  const tgtCols = new Map(tgt.columns.map((c) => [c.name, c]));

  const alters: string[] = [];
  const destructive: boolean[] = [];

  for (const col of src.columns) {
    const t = tgtCols.get(col.name);
    if (!t) {
      alters.push(`ADD COLUMN ${columnDef(col)}`);
      destructive.push(false);
    } else if (!columnsEqual(col, t, debugLog ? (m) => debugLog(`[${src.name}] ${m}`) : undefined)) {
      alters.push(`MODIFY COLUMN ${columnDef(col)}`);
      destructive.push(false);
    }
  }
  for (const col of tgt.columns) {
    if (!srcCols.has(col.name)) {
      alters.push(`DROP COLUMN ${qid(col.name)}`);
      destructive.push(true);
    }
  }

  const srcIdx = new Map(src.indexes.map((i) => [i.name, i]));
  const tgtIdx = new Map(tgt.indexes.map((i) => [i.name, i]));
  for (const [name, i] of srcIdx) {
    const t = tgtIdx.get(name);
    if (!t) {
      if (name === "PRIMARY") alters.push(`ADD PRIMARY KEY (${i.columns.map(qid).join(",")})`);
      else alters.push(`ADD ${i.unique ? "UNIQUE " : ""}INDEX ${qid(name)} (${i.columns.map(qid).join(",")})`);
      destructive.push(false);
    } else if (indexSignature(i) !== indexSignature(t)) {
      if (name === "PRIMARY") {
        alters.push("DROP PRIMARY KEY");
        alters.push(`ADD PRIMARY KEY (${i.columns.map(qid).join(",")})`);
      } else {
        alters.push(`DROP INDEX ${qid(name)}`);
        alters.push(`ADD ${i.unique ? "UNIQUE " : ""}INDEX ${qid(name)} (${i.columns.map(qid).join(",")})`);
      }
      destructive.push(true, false);
    }
  }
  for (const [name] of tgtIdx) {
    if (!srcIdx.has(name)) {
      alters.push(name === "PRIMARY" ? "DROP PRIMARY KEY" : `DROP INDEX ${qid(name)}`);
      destructive.push(true);
    }
  }

  if (alters.length) {
    out.push({
      kind: "alter-table",
      object: src.name,
      sql: `ALTER TABLE ${qid(src.name)} ${alters.join(", ")}`,
      destructive: destructive.some(Boolean),
    });
  }
  return out;
}

/** Diff produces statements that, applied to `target`, make it look like `source`. */
export function diffSchemas(source: SchemaSnapshot, target: SchemaSnapshot, debugLog?: (msg: string) => void): SchemaStatement[] {
  const out: SchemaStatement[] = [];

  // Tables
  for (const [name, src] of source.tables) {
    const tgt = target.tables.get(name);
    if (!tgt) {
      out.push({ kind: "create-table", object: name, sql: src.createStatement, destructive: false });
    } else {
      // Sync table-level collation first so new columns inherit the right charset
      if (src.collation && src.collation !== tgt.collation) {
        const charset = src.collation.split("_")[0];
        out.push({
          kind: "alter-table",
          object: name,
          sql: `ALTER TABLE ${qid(name)} DEFAULT CHARACTER SET ${charset} COLLATE ${src.collation}`,
          destructive: false,
        });
      }
      // Sync column/index structure (compare structurally, not via raw CREATE string)
      out.push(...diffTable(src, tgt, debugLog));
    }
  }
  for (const [name] of target.tables) {
    if (!source.tables.has(name)) {
      out.push({ kind: "drop-table", object: name, sql: `DROP TABLE ${qid(name)}`, destructive: true });
    }
  }

  // Views
  for (const [name, v] of source.views) {
    const t = target.views.get(name);
    if (!t) out.push({ kind: "create-view", object: name, sql: v.definition, destructive: false });
    else if (v.definition !== t.definition)
      out.push({ kind: "alter-view", object: name, sql: `DROP VIEW IF EXISTS ${qid(name)};\n${v.definition}`, destructive: true });
  }
  for (const [name] of target.views) {
    if (!source.views.has(name))
      out.push({ kind: "drop-view", object: name, sql: `DROP VIEW ${qid(name)}`, destructive: true });
  }

  // Routines (drop + create strategy on difference)
  for (const [key, r] of source.routines) {
    const t = target.routines.get(key);
    if (!t || t.definition !== r.definition) {
      out.push({
        kind: "create-routine",
        object: key,
        sql: `DROP ${r.kind} IF EXISTS ${qid(r.name)};\n${r.definition}`,
        destructive: Boolean(t),
      });
    }
  }
  for (const [key, r] of target.routines) {
    if (!source.routines.has(key))
      out.push({ kind: "drop-routine", object: key, sql: `DROP ${r.kind} ${qid(r.name)}`, destructive: true });
  }

  // Triggers
  for (const [name, tr] of source.triggers) {
    const t = target.triggers.get(name);
    if (!t || t.definition !== tr.definition) {
      out.push({
        kind: "create-trigger",
        object: name,
        sql: `DROP TRIGGER IF EXISTS ${qid(name)};\n${tr.definition}`,
        destructive: Boolean(t),
      });
    }
  }
  for (const [name] of target.triggers) {
    if (!source.triggers.has(name))
      out.push({ kind: "drop-trigger", object: name, sql: `DROP TRIGGER ${qid(name)}`, destructive: true });
  }

  return out;
}
