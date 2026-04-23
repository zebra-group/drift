import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Profile } from "../vault/types.js";
import { openConnection } from "../connection/connection.js";
import { K8sClient, type PortForwardHandle } from "../k8s/port-forward.js";

export interface DumpOptions {
  tables?: string[];
  extraArgs?: string[];
  binary?: string;
}

interface ResolvedEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  cleanup: () => Promise<void>;
}

async function resolveEndpoint(profile: Profile, databaseOverride?: string): Promise<ResolvedEndpoint> {
  const database = databaseOverride ?? profile.database;

  if (profile.kind === "direct") {
    if (!database) throw new Error(`Profile ${profile.name} has no database set`);
    return { host: profile.host, port: profile.port, user: profile.user, password: profile.password, database, cleanup: async () => undefined };
  }

  if (profile.kind === "ssh") {
    if (!database) throw new Error(`Profile ${profile.name} has no database set`);
    const { createSshTunnel } = await import("../ssh/tunnel.js");
    const tunnel = await createSshTunnel({
      sshHost: profile.sshHost, sshPort: profile.sshPort, sshUser: profile.sshUser,
      privateKeyPath: profile.sshPrivateKeyPath, password: profile.sshPassword,
      remoteHost: profile.host, remotePort: profile.port,
    });
    return { host: "127.0.0.1", port: tunnel.localPort, user: profile.user, password: profile.password, database, cleanup: () => tunnel.close() };
  }

  if (profile.kind === "docker") {
    if (!database) throw new Error(`Profile ${profile.name} has no database set`);
    const { getContainerPort } = await import("../docker/docker.js");
    const localPort = await getContainerPort(profile.containerId, profile.internalPort);
    return { host: "127.0.0.1", port: localPort, user: profile.user, password: profile.password, database, cleanup: async () => undefined };
  }

  // K8s
  if (!database) throw new Error(`K8s profile ${profile.name} has no database set`);
  const k8s = new K8sClient(profile.kubeconfigPath);
  let fwd: PortForwardHandle | undefined;
  try {
    fwd = await k8s.startPortForward({ context: profile.context, namespace: profile.namespace, target: profile.target, remotePort: profile.remotePort });
    const handle = fwd;
    return { host: "127.0.0.1", port: handle.localPort, user: profile.user, password: profile.password, database, cleanup: () => handle.close() };
  } catch (err) {
    if (fwd) await fwd.close().catch(() => undefined);
    throw err;
  }
}

function buildDumpArgs(ep: ResolvedEndpoint, opts: DumpOptions): string[] {
  return [
    `--host=${ep.host}`,
    `--port=${ep.port}`,
    `--user=${ep.user}`,
    "--single-transaction",
    "--set-gtid-purged=OFF",
    "--column-statistics=0",
    "--routines",
    "--triggers",
    "--events",
    "--add-drop-table",
    "--default-character-set=utf8mb4",
    ...(opts.extraArgs ?? []),
    ep.database,
    ...(opts.tables ?? []),
  ];
}

/** Dump a database to a .sql file. Returns the output path. */
export async function dumpToFile(
  profile: Profile,
  database: string,
  outputPath: string,
  opts: DumpOptions = {},
  onProgress?: (msg: string) => void,
): Promise<string> {
  const ep = await resolveEndpoint(profile, database);
  try {
    const args = buildDumpArgs(ep, opts);
    const child = spawn(opts.binary ?? "mysqldump", args, {
      env: { ...process.env, MYSQL_PWD: ep.password },
    });

    const outStream = createWriteStream(outputPath);
    child.stderr.on("data", (chunk: Buffer) => onProgress?.(`⚠ ${chunk.toString("utf8").trim()}`));

    await new Promise<void>((resolve, reject) => {
      child.stdout.pipe(outStream);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`mysqldump exited with code ${code}`));
        else resolve();
      });
    });

    return outputPath;
  } finally {
    await ep.cleanup();
  }
}

/** Full-overwrite: streams mysqldump(source) into target via mysql2. */
export async function fullOverwrite(source: Profile, target: Profile, opts: DumpOptions = {}): Promise<void> {
  const srcEp = await resolveEndpoint(source);
  const tgt = await openConnection(target);
  try {
    const args = buildDumpArgs(srcEp, opts);
    const child = spawn(opts.binary ?? "mysqldump", args, {
      env: { ...process.env, MYSQL_PWD: srcEp.password },
    });

    let buffer = "";
    const conn = await tgt.pool.getConnection();
    try {
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      for await (const chunk of child.stdout) {
        buffer += (chunk as Buffer).toString("utf8");
        let idx: number;
        while ((idx = nextStatementEnd(buffer)) >= 0) {
          const stmt = buffer.slice(0, idx + 1).trim();
          buffer = buffer.slice(idx + 1);
          if (stmt && !stmt.startsWith("--") && !stmt.startsWith("/*!")) {
            try { await conn.query(stmt); } catch (e) { throw new Error(`restore failed at: ${stmt.slice(0, 120)}…\n${(e as Error).message}`); }
          }
        }
      }
      if (buffer.trim()) await conn.query(buffer);
      await conn.query("SET FOREIGN_KEY_CHECKS=1");
    } finally {
      conn.release();
    }

    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) {
      const stderr = await streamToString(child.stderr);
      throw new Error(`mysqldump exited with code ${code}: ${stderr}`);
    }
  } finally {
    await tgt.close();
    await srcEp.cleanup();
  }
}

function nextStatementEnd(buf: string): number {
  let inSingle = false, inDouble = false, inBacktick = false, inLineComment = false, inBlockComment = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const next = buf[i + 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
    if (inBlockComment) { if (c === "*" && next === "/") { inBlockComment = false; i++; } continue; }
    if (inSingle) { if (c === "\\") { i++; continue; } if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === "\\") { i++; continue; } if (c === '"') inDouble = false; continue; }
    if (inBacktick) { if (c === "`") inBacktick = false; continue; }
    if (c === "-" && next === "-") { inLineComment = true; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") { inBacktick = true; continue; }
    if (c === ";") return i;
  }
  return -1;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
