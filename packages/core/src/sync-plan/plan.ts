import type { Pool } from "mysql2/promise";
import type { SchemaStatement } from "../schema-diff/diff.js";
import { diffSchemas } from "../schema-diff/diff.js";
import { introspect } from "../schema-diff/introspect.js";
import { diffTableData, type DataStatement } from "../data-diff/data-diff.js";
import { applyTableFilter } from "../filters/filters.js";
import type { TableFilter } from "../vault/types.js";

export interface SyncPlan {
  sourceDatabase: string;
  targetDatabase: string;
  schema: SchemaStatement[];
  data: DataStatement[];
  createdAt: string;
}

export interface BuildPlanOptions {
  mode: { schema: boolean; data: boolean };
  filter?: TableFilter;
  onProgress?: (msg: string) => void;
}

export async function buildPlan(
  sourcePool: Pool,
  targetPool: Pool,
  sourceDatabase: string,
  targetDatabase: string,
  opts: BuildPlanOptions,
): Promise<SyncPlan> {
  const plan: SyncPlan = {
    sourceDatabase,
    targetDatabase,
    schema: [],
    data: [],
    createdAt: new Date().toISOString(),
  };

  const log = opts.onProgress ?? (() => {});

  log(`Verbinde und lese Schema: ${sourceDatabase} …`);
  const srcSnap = await introspect(sourcePool, sourceDatabase);
  log(`Schema gelesen: ${srcSnap.tables.size} Tabellen in ${sourceDatabase}`);

  log(`Verbinde und lese Schema: ${targetDatabase} …`);
  const tgtSnap = await introspect(targetPool, targetDatabase);
  log(`Schema gelesen: ${tgtSnap.tables.size} Tabellen in ${targetDatabase}`);

  if (opts.mode.schema) {
    log("Berechne Schema-Diff …");
    const all = diffSchemas(srcSnap, tgtSnap, log);
    const allowed = new Set(applyTableFilter(Array.from(srcSnap.tables.keys()).concat(Array.from(tgtSnap.tables.keys())), opts.filter));
    plan.schema = all.filter((s) => {
      if (s.kind.endsWith("-table")) return allowed.has(s.object);
      return true;
    });
    log(`Schema-Diff: ${plan.schema.length} Statement(s)`);
  }

  if (opts.mode.data) {
    const commonTables = Array.from(srcSnap.tables.keys()).filter((t) => tgtSnap.tables.has(t));
    const allowed = applyTableFilter(commonTables, opts.filter);
    log(`Daten-Diff: ${allowed.length} Tabelle(n) werden verglichen …`);
    for (const t of allowed) {
      const src = srcSnap.tables.get(t)!;
      if (src.primaryKey.length === 0) {
        log(`  ${t}: übersprungen (kein Primary Key)`);
        continue;
      }
      log(`  ${t}: vergleiche Zeilen …`);
      const cols = src.columns.map((c) => c.name);
      const stmts = await diffTableData(sourcePool, targetPool, {
        sourceDatabase,
        targetDatabase,
        table: t,
        primaryKey: src.primaryKey,
        columns: cols,
        ignoreColumns: opts.filter?.ignoreColumns,
      });
      for (const s of stmts) plan.data.push(s);
      log(`  ${t}: ${stmts.length} Änderung(en)`);
    }
  }

  return plan;
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** Continue on per-statement errors instead of rolling back. */
  continueOnError?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ApplyResult {
  executed: number;
  skipped: number;
  errors: { sql: string; error: string }[];
}

export async function applyPlan(pool: Pool, plan: SyncPlan, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const result: ApplyResult = { executed: 0, skipped: 0, errors: [] };
  const log = opts.onProgress ?? (() => {});
  const total = plan.schema.length + plan.data.length;

  if (opts.dryRun) {
    log(`Dry-run: ${total} statement(s) would be executed`);
    result.skipped = total;
    return result;
  }

  log(`Connecting to target database \`${plan.targetDatabase}\`…`);
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE \`${plan.targetDatabase}\``);
    log(`[apply] target database: ${plan.targetDatabase}`);
    await conn.query("SET autocommit=1");
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    try { await conn.query("SET check_constraint_checks=0"); } catch {} // MariaDB only

    log(`Executing ${plan.schema.length} schema + ${plan.data.length} data statement(s)…`);

    for (const s of plan.schema) {
      try {
        await conn.query(s.sql);
        result.executed++;
        log(`✓ [schema] ${s.kind} ${s.object}: ${s.sql.slice(0, 120).replace(/\n/g, " ")}`);
      } catch (e) {
        const msg = (e as Error).message;
        result.errors.push({ sql: s.sql, error: msg });
        log(`✗ [schema] ${s.kind} ${s.object}: ${msg}`);
        if (!opts.continueOnError) throw e;
      }
    }
    let dataOk = 0;
    const dataErrors: string[] = [];
    for (const s of plan.data) {
      try {
        await conn.query(s.sql, s.params);
        result.executed++;
        dataOk++;
      } catch (e) {
        const msg = (e as Error).message;
        result.errors.push({ sql: s.sql, error: msg });
        dataErrors.push(`✗ [data] ${s.kind} ${s.table}: ${msg}`);
        if (!opts.continueOnError) throw e;
      }
    }
    if (plan.data.length) log(`✓ Data: ${dataOk} ok, ${dataErrors.length} error(s) out of ${plan.data.length} statement(s)`);
    if (dataErrors.length) {
      for (const line of dataErrors.slice(0, 10)) log(line);
      if (dataErrors.length > 10) log(`  … and ${dataErrors.length - 10} more data error(s)`);
    }

    await conn.query("COMMIT");
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
    try { await conn.query("SET check_constraint_checks=1"); } catch {}
  } finally {
    conn.release();
  }
  log(`✓ Done — ${result.executed} executed, ${result.errors.length} error(s)`);
  return result;
}
