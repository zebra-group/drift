import * as k8s from "@kubernetes/client-node";
import { createServer, type Server, type Socket } from "node:net";
import { AddressInfo } from "node:net";
import type { SecretValueRef } from "../vault/types.js";

export interface PortForwardHandle {
  localPort: number;
  close(): Promise<void>;
}

export interface PortForwardOptions {
  kubeconfigPath?: string;
  context: string;
  namespace: string;
  target: { kind: "pod" | "service"; name: string };
  remotePort: number;
}

export class K8sClient {
  readonly kc: k8s.KubeConfig;

  constructor(kubeconfigPath?: string) {
    this.kc = new k8s.KubeConfig();
    if (kubeconfigPath) this.kc.loadFromFile(kubeconfigPath);
    else this.kc.loadFromDefault();
  }

  useContext(context: string): void {
    this.kc.setCurrentContext(context);
  }

  listContexts(): string[] {
    return this.kc.getContexts().map((c) => c.name);
  }

  async listNamespaces(context?: string): Promise<string[]> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listNamespace();
    return res.body.items.map((n) => n.metadata?.name ?? "").filter(Boolean);
  }

  async listPods(namespace: string, context?: string): Promise<string[]> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listNamespacedPod(namespace);
    return res.body.items.map((p) => p.metadata?.name ?? "").filter(Boolean);
  }

  async listServices(namespace: string, context?: string): Promise<string[]> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listNamespacedService(namespace);
    return res.body.items.map((s) => s.metadata?.name ?? "").filter(Boolean);
  }

  async listSecrets(namespace: string, context?: string): Promise<string[]> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.listNamespacedSecret(namespace);
    return res.body.items.map((s) => s.metadata?.name ?? "").filter(Boolean);
  }

  async getSecretKeys(namespace: string, secretName: string, context?: string): Promise<string[]> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.readNamespacedSecret(secretName, namespace);
    return Object.keys(res.body.data ?? {});
  }

  async resolveSecretValue(namespace: string, ref: SecretValueRef, context?: string): Promise<string> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const res = await api.readNamespacedSecret(ref.secretName, namespace);
    const raw = (res.body.data ?? {})[ref.key];
    if (raw === undefined) throw new Error(`Key "${ref.key}" not found in secret "${ref.secretName}"`);
    return Buffer.from(raw, "base64").toString("utf-8");
  }

  /**
   * Resolve a Service to one of its backing Pod names. For ClusterIP services
   * we need an actual pod to port-forward against (Services can't be
   * port-forwarded directly via the Kubernetes API).
   */
  async resolveServiceToPod(namespace: string, service: string, context?: string): Promise<string> {
    if (context) this.useContext(context);
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const svc = await api.readNamespacedService(service, namespace);
    const selector = svc.body.spec?.selector;
    if (!selector || Object.keys(selector).length === 0) {
      throw new Error(`Service ${service} has no selector; cannot port-forward`);
    }
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
    const pods = await api.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
    const running = pods.body.items.find((p) => p.status?.phase === "Running");
    if (!running?.metadata?.name) throw new Error(`No running pods match service ${service}`);
    return running.metadata.name;
  }

  async startPortForward(opts: PortForwardOptions): Promise<PortForwardHandle> {
    if (opts.kubeconfigPath) {
      // already loaded in constructor; ignore here
    }
    this.useContext(opts.context);
    const fwd = new k8s.PortForward(this.kc);
    const podName =
      opts.target.kind === "pod"
        ? opts.target.name
        : await this.resolveServiceToPod(opts.namespace, opts.target.name);

    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // @kubernetes/client-node PortForward expects (namespace, pod, ports[], stdout, stderr, stdin)
      fwd.portForward(opts.namespace, podName, [opts.remotePort], socket, null, socket).catch((err) => {
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const localPort = (server.address() as AddressInfo).port;

    return {
      localPort,
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    };
  }
}
