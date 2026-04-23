import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { Vault, openConnection, applyPlan, type SyncPlan } from "@db-mirror/core";
import { defaultVaultPath } from "../paths.js";
import { readPassphrase } from "../passphrase.js";
import { createInterface } from "node:readline";

export function applyCommand(): Command {
  return new Command("apply")
    .description("Apply a SyncPlan JSON file to a target profile")
    .argument("<plan>", "plan JSON file")
    .requiredOption("--target <idOrName>", "target profile")
    .option("--dry-run", "show what would run, do nothing", false)
    .option("--yes", "skip confirmation", false)
    .option("--continue-on-error", "don't abort on per-statement errors", false)
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (planPath, opts) => {
      const plan = JSON.parse(await readFile(planPath, "utf8")) as SyncPlan;
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const tp = v.getProfile(opts.target);
      if (!tp) { console.error("Target profile not found"); process.exit(1); }

      const destructive = plan.schema.some((s) => s.destructive) || plan.data.some((s) => s.destructive);
      console.log(`Plan: ${plan.schema.length} schema, ${plan.data.length} data statements; destructive=${destructive}`);
      if (!opts.dryRun && !opts.yes && destructive) {
        const ok = await confirm(`Type the target profile name to continue (${tp.name}): `, tp.name);
        if (!ok) { console.error("Aborted"); process.exit(1); }
      }
      const conn = await openConnection(tp);
      try {
        const res = await applyPlan(conn.pool, plan, { dryRun: opts.dryRun, continueOnError: opts.continueOnError });
        console.log(`executed=${res.executed} skipped=${res.skipped} errors=${res.errors.length}`);
        for (const e of res.errors) console.error(`ERR: ${e.error}\n     ${e.sql.slice(0, 200)}`);
        if (res.errors.length) process.exit(2);
      } finally {
        await conn.close();
      }
    });
}

function confirm(label: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (a) => { rl.close(); resolve(a.trim() === expected); });
  });
}
