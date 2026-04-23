import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { Vault, openConnection, buildPlan } from "@db-mirror/core";
import { defaultVaultPath } from "../paths.js";
import { readPassphrase } from "../passphrase.js";

export function diffCommand(): Command {
  return new Command("diff")
    .description("Compute a SyncPlan between two profiles")
    .argument("<source>", "source profile (id or name)")
    .argument("<target>", "target profile (id or name)")
    .option("--schema", "include schema diff", false)
    .option("--data", "include data diff", false)
    .option("--both", "include both schema and data diff", false)
    .option("--source-db <db>", "override source database")
    .option("--target-db <db>", "override target database")
    .option("--include <glob...>", "table include globs")
    .option("--exclude <glob...>", "table exclude globs")
    .option("--ignore-columns <cols...>", "columns to ignore during data-diff")
    .option("--out <file>", "write plan JSON to file")
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (source, target, opts) => {
      const schema = Boolean(opts.schema || opts.both);
      const data = Boolean(opts.data || opts.both);
      if (!schema && !data) {
        console.error("Pick at least one of --schema, --data, --both");
        process.exit(2);
      }
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const sp = v.getProfile(source);
      const tp = v.getProfile(target);
      if (!sp || !tp) { console.error("Profile(s) not found"); process.exit(1); }

      const srcConn = await openConnection(sp);
      const tgtConn = await openConnection(tp);
      try {
        const srcDb = opts.sourceDb ?? sp.database;
        const tgtDb = opts.targetDb ?? tp.database ?? srcDb;
        if (!srcDb || !tgtDb) { console.error("Database is required (profile.database or --source-db/--target-db)"); process.exit(2); }
        const plan = await buildPlan(srcConn.pool, tgtConn.pool, srcDb, tgtDb, {
          mode: { schema, data },
          filter: {
            include: opts.include ?? [],
            exclude: opts.exclude ?? [],
            ignoreColumns: opts.ignoreColumns,
          },
        });
        const json = JSON.stringify(plan, null, 2);
        if (opts.out) {
          await writeFile(opts.out, json);
          console.log(`Wrote plan to ${opts.out}: ${plan.schema.length} schema, ${plan.data.length} data statements`);
        } else {
          console.log(json);
        }
      } finally {
        await srcConn.close();
        await tgtConn.close();
      }
    });
}
