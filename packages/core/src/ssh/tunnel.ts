import { Client, type ConnectConfig } from "ssh2";
import * as net from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

function expandPath(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

export interface SshTunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKeyPath?: string;
  password?: string;
  remoteHost: string;
  remotePort: number;
}

export interface TunnelHandle {
  localPort: number;
  close(): Promise<void>;
}

export async function createSshTunnel(config: SshTunnelConfig): Promise<TunnelHandle> {
  const connectCfg: ConnectConfig = {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUser,
    readyTimeout: 20000,
  };

  if (config.privateKeyPath) {
    connectCfg.privateKey = await readFile(expandPath(config.privateKeyPath));
  } else if (config.password) {
    connectCfg.password = config.password;
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const sockets: net.Socket[] = [];
    let server: net.Server | undefined;

    conn.on("ready", () => {
      server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on("close", () => {
          const idx = sockets.indexOf(socket);
          if (idx >= 0) sockets.splice(idx, 1);
        });

        conn.forwardOut("127.0.0.1", 0, config.remoteHost, config.remotePort, (err, stream) => {
          if (err) { socket.destroy(); return; }
          socket.pipe(stream).pipe(socket);
          stream.on("close", () => socket.destroy());
          socket.on("close", () => stream.destroy());
        });
      });

      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address() as net.AddressInfo;
        resolve({
          localPort: addr.port,
          close: () =>
            new Promise<void>((res) => {
              sockets.forEach((s) => s.destroy());
              server!.close(() => { conn.end(); res(); });
            }),
        });
      });
    });

    conn.on("error", reject);
    conn.connect(connectCfg);
  });
}
