import { homedir } from "node:os";
import { join } from "node:path";

export function defaultVaultPath(): string {
  return process.env.DB_MIRROR_VAULT ?? join(homedir(), ".config", "db-mirror", "vault.db-mirror");
}
