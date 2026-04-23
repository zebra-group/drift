import { Command } from "commander";
import { Vault } from "@db-mirror/core";
import { defaultVaultPath } from "../paths.js";
import { readPassphrase } from "../passphrase.js";

export function vaultCommand(): Command {
  const cmd = new Command("vault").description("Manage the encrypted credential vault");

  cmd
    .command("init")
    .description("Create a new vault")
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (opts) => {
      if (await Vault.exists(opts.path)) {
        console.error(`Vault already exists at ${opts.path}`);
        process.exit(1);
      }
      const pass = await readPassphrase({ file: opts.passphraseFile, promptLabel: "New master passphrase: " });
      await Vault.create(opts.path, pass);
      console.log(`Created vault at ${opts.path}`);
    });

  cmd
    .command("list")
    .description("List profiles and sync pairs")
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (opts) => {
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      console.log("Profiles:");
      for (const p of v.listProfiles()) {
        const loc = p.kind === "direct" ? `${p.host}:${p.port}` : `k8s ${p.context}/${p.namespace}/${p.target.kind}:${p.target.name}:${p.remotePort}`;
        console.log(`  [${p.kind}] ${p.name}  → ${loc}  db=${p.database ?? "-"}  id=${p.id}`);
      }
      console.log("Pairs:");
      for (const pair of v.listPairs()) {
        console.log(`  ${pair.name}  source=${pair.sourceProfileId}  target=${pair.targetProfileId}`);
      }
    });

  cmd
    .command("add-profile")
    .description("Add or update a direct MySQL/MariaDB profile")
    .requiredOption("--name <name>", "profile name")
    .requiredOption("--host <host>", "server host")
    .option("--port <port>", "server port", "3306")
    .requiredOption("--user <user>", "username")
    .requiredOption("--password <password>", "password (prefer env MYSQL_PW or stdin in future)")
    .option("--database <db>", "default database")
    .option("--tls", "enable TLS", false)
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (opts) => {
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const p = await v.upsertProfile({
        kind: "direct",
        name: opts.name,
        host: opts.host,
        port: Number(opts.port),
        user: opts.user,
        password: opts.password,
        database: opts.database,
        tls: Boolean(opts.tls),
      });
      console.log(`Saved profile ${p.name} (${p.id})`);
    });

  cmd
    .command("add-k8s")
    .description("Add or update a Kubernetes-forwarded MySQL/MariaDB profile")
    .requiredOption("--name <name>", "profile name")
    .requiredOption("--context <ctx>", "kube context")
    .requiredOption("--namespace <ns>", "namespace")
    .requiredOption("--target <pod|service:name>", "target reference, e.g. 'pod:mysql-0' or 'service:mysql'")
    .option("--remote-port <port>", "remote port", "3306")
    .option("--kubeconfig <file>", "custom kubeconfig path")
    .option("--user <user>", "mysql username (manual)")
    .option("--user-secret <secret>", "K8s Secret name to read the username from")
    .option("--user-key <key>", "key inside --user-secret for the username", "username")
    .option("--password <password>", "mysql password (manual)")
    .option("--password-secret <secret>", "K8s Secret name to read the password from")
    .option("--password-key <key>", "key inside --password-secret for the password", "password")
    .option("--database <db>", "default database")
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (opts) => {
      const [kind, name] = String(opts.target).split(":");
      if ((kind !== "pod" && kind !== "service") || !name) {
        console.error("Invalid --target; expected 'pod:<name>' or 'service:<name>'");
        process.exit(2);
      }
      if (!opts.user && !opts.userSecret) { console.error("Provide --user or --user-secret"); process.exit(2); }
      if (!opts.password && !opts.passwordSecret) { console.error("Provide --password or --password-secret"); process.exit(2); }

      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const p = await v.upsertProfile({
        kind: "k8s",
        name: opts.name,
        context: opts.context,
        namespace: opts.namespace,
        target: { kind: kind as "pod" | "service", name },
        remotePort: Number(opts.remotePort),
        kubeconfigPath: opts.kubeconfig,
        user: opts.user ?? "",
        userFrom: opts.userSecret ? { secretName: opts.userSecret, key: opts.userKey } : undefined,
        password: opts.password ?? "",
        passwordFrom: opts.passwordSecret ? { secretName: opts.passwordSecret, key: opts.passwordKey } : undefined,
        database: opts.database,
      });
      const userSrc = opts.userSecret ? `secret "${opts.userSecret}[${opts.userKey}]"` : "manual";
      const passSrc = opts.passwordSecret ? `secret "${opts.passwordSecret}[${opts.passwordKey}]"` : "manual";
      console.log(`Saved k8s profile ${p.name} (${p.id}) — user: ${userSrc}, password: ${passSrc}`);
    });

  cmd
    .command("remove-profile <idOrName>")
    .description("Remove a profile by id or name")
    .option("-p, --path <file>", "vault file path", defaultVaultPath())
    .option("--passphrase-file <file>", "read passphrase from file")
    .action(async (idOrName, opts) => {
      const pass = await readPassphrase({ file: opts.passphraseFile });
      const v = await Vault.open(opts.path, pass);
      const p = v.getProfile(idOrName);
      if (!p) { console.error("Not found"); process.exit(1); }
      await v.removeProfile(p.id);
      console.log(`Removed ${p.name}`);
    });

  return cmd;
}
