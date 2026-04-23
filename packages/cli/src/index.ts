import { Command } from "commander";
import { vaultCommand } from "./commands/vault-cmd.js";
import { diffCommand } from "./commands/diff-cmd.js";
import { applyCommand } from "./commands/apply-cmd.js";
import { mirrorCommand } from "./commands/mirror-cmd.js";
import { k8sCommand } from "./commands/k8s-cmd.js";

const program = new Command();
program
  .name("db-mirror")
  .description("Mirror MySQL/MariaDB databases between two servers (incl. Kubernetes port-forward)")
  .version("0.1.0");

program.addCommand(vaultCommand());
program.addCommand(diffCommand());
program.addCommand(applyCommand());
program.addCommand(mirrorCommand());
program.addCommand(k8sCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
