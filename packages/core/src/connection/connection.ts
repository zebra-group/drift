import mysql, { type Pool } from "mysql2/promise";
import type { Profile } from "../vault/types.js";
import { K8sClient, type PortForwardHandle } from "../k8s/port-forward.js";

export interface OpenedConnection {
  pool: Pool;
  close(): Promise<void>;
  label: string;
}

export async function openConnection(profile: Profile): Promise<OpenedConnection> {
  if (profile.kind === "direct") {
    const pool = mysql.createPool({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password: profile.password,
      database: profile.database,
      ssl: profile.tls ? {} : undefined,
      multipleStatements: true,
      dateStrings: true,
      timezone: "+00:00",
      connectionLimit: 4,
    });
    return {
      pool,
      label: `${profile.name} (${profile.host}:${profile.port})`,
      close: () => pool.end(),
    };
  }

  if (profile.kind === "ssh") {
    const { createSshTunnel } = await import("../ssh/tunnel.js");
    const tunnel = await createSshTunnel({
      sshHost: profile.sshHost,
      sshPort: profile.sshPort,
      sshUser: profile.sshUser,
      privateKeyPath: profile.sshPrivateKeyPath,
      password: profile.sshPassword,
      remoteHost: profile.host,
      remotePort: profile.port,
    });
    try {
      const pool = mysql.createPool({
        host: "127.0.0.1",
        port: tunnel.localPort,
        user: profile.user,
        password: profile.password,
        database: profile.database,
        ssl: profile.tls ? {} : undefined,
        multipleStatements: true,
        dateStrings: true,
        timezone: "+00:00",
        connectionLimit: 4,
      });
      return {
        pool,
        label: `${profile.name} (ssh://${profile.sshUser}@${profile.sshHost} → ${profile.host}:${profile.port})`,
        close: async () => {
          await pool.end().catch(() => undefined);
          await tunnel.close();
        },
      };
    } catch (err) {
      await tunnel.close().catch(() => undefined);
      throw err;
    }
  }

  if (profile.kind === "docker") {
    const { getContainerPort } = await import("../docker/docker.js");
    const localPort = await getContainerPort(profile.containerId, profile.internalPort);
    const pool = mysql.createPool({
      host: "127.0.0.1",
      port: localPort,
      user: profile.user,
      password: profile.password,
      database: profile.database,
      multipleStatements: true,
      dateStrings: true,
      timezone: "+00:00",
      connectionLimit: 4,
    });
    return {
      pool,
      label: `${profile.name} (docker:${profile.containerName}:${localPort})`,
      close: () => pool.end(),
    };
  }

  // K8s
  const k8s = new K8sClient(profile.kubeconfigPath);
  let fwd: PortForwardHandle | undefined;
  try {
    const [user, password] = await Promise.all([
      profile.userFrom
        ? k8s.resolveSecretValue(profile.namespace, profile.userFrom, profile.context)
        : Promise.resolve(profile.user),
      profile.passwordFrom
        ? k8s.resolveSecretValue(profile.namespace, profile.passwordFrom, profile.context)
        : Promise.resolve(profile.password),
    ]);

    fwd = await k8s.startPortForward({
      context: profile.context,
      namespace: profile.namespace,
      target: profile.target,
      remotePort: profile.remotePort,
    });
    const handle = fwd;
    const pool = mysql.createPool({
      host: "127.0.0.1",
      port: handle.localPort,
      user,
      password,
      database: profile.database,
      multipleStatements: true,
      dateStrings: true,
      timezone: "+00:00",
      connectionLimit: 4,
    });
    return {
      pool,
      label: `${profile.name} (k8s ${profile.context}/${profile.namespace}/${profile.target.name} → 127.0.0.1:${handle.localPort})`,
      close: async () => {
        await pool.end().catch(() => undefined);
        await handle.close();
      },
    };
  } catch (err) {
    if (fwd) await fwd.close().catch(() => undefined);
    throw err;
  }
}
