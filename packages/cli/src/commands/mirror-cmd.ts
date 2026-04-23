import { Command } from "commander";
import { Vault, openConnection, buildPlan, applyPlan, fullOverwrite } from "@db-mirror/core";
import { defaultVaultPath } from "../paths.js";
import { readPassphrase } from "../passphrase.js";
import { createInterface } from "node:readline";

export function mirrorCommand(): Command {
  return new Command("mirror")
    .description("End-to-end mirror: compute + apply in one go")
    .argument("<source>", "source profile")
    .argument("<target>", "target profile")
    .option("--mode <mode>", "overwrite | diff", "diff")
    .option("--schema", "include schema diff (mode=diff)", false)
    .option("--data", "include data diff (mode=diff)", false)
    .option("--both", "include both (mode=diff)", true)
    .option("--source-db <db>", "override source database")
    .option("--target-db <db>", "override target database")
    .option("--include <glob...>", "table include globs")
    .option("--exclude <glob...>", "table exclude globs")
    .option("--dry-run", "do not modify target", false)
    .option("--yes", "skip confirmation", false)
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (source, target, opts) => {
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const sp = v.getProfile(source);
      const tp = v.getProfile(target);
      if (!sp || !tp) { console.error("Profile(s) not found"); process.exit(1); }

      if (!opts.yes && !opts.dryRun) {
        const ok = await confirm(`About to modify target ${tp.name}. Type name to confirm: `, tp.name);
        if (!ok) { console.error("Aborted"); process.exit(1); }
      }

      if (opts.mode === "overwrite") {
        if (opts.dryRun) { console.log(`[dry-run] would overwrite ${tp.name} from ${sp.name}`); return; }
        await fullOverwrite(sp, tp, { tables: opts.include });
        console.log("Overwrite complete");
        return;
      }

      const schema = Boolean(opts.schema || opts.both);
      const data = Boolean(opts.data || opts.both);
      const srcConn = await openConnection(sp);
      const tgtConn = await openConnection(tp);
      try {
        const srcDb = opts.sourceDb ?? sp.database;
        const tgtDb = opts.targetDb ?? tp.database ?? srcDb;
        if (!srcDb || !tgtDb) { console.error("Database required"); process.exit(2); }
        const plan = await buildPlan(srcConn.pool, tgtConn.pool, srcDb, tgtDb, {
          mode: { schema, data },
          filter: { include: opts.include ?? [], exclude: opts.exclude ?? [] },
        });
        console.log(`Plan: ${plan.schema.length} schema, ${plan.data.length} data statements`);
        const res = await applyPlan(tgtConn.pool, plan, { dryRun: opts.dryRun });
        console.log(`executed=${res.executed} skipped=${res.skipped} errors=${res.errors.length}`);
      } finally {
        await srcConn.close();
        await tgtConn.close();
      }
    });
}

function confirm(label: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (a) => { rl.close(); resolve(a.trim() === expected); });
  });
}
