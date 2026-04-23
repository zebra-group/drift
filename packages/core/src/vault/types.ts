export interface DirectProfile {
  kind: "direct";
  id: string;
  name: string;
  folder?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  tls?: boolean;
}

/** Reference to a single key inside a Kubernetes Secret. */
export interface SecretValueRef {
  secretName: string;
  key: string;
}

export interface K8sProfile {
  kind: "k8s";
  id: string;
  name: string;
  folder?: string;
  kubeconfigPath?: string;
  context: string;
  namespace: string;
  target: { kind: "pod" | "service"; name: string };
  remotePort: number;
  userFrom?: SecretValueRef;
  passwordFrom?: SecretValueRef;
  user: string;
  password: string;
  database?: string;
}

export interface SshProfile {
  kind: "ssh";
  id: string;
  name: string;
  folder?: string;
  // SSH jump host
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** Path to private key file on disk. Mutually exclusive with sshPassword. */
  sshPrivateKeyPath?: string;
  sshPassword?: string;
  // Target DB (reached through tunnel)
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  tls?: boolean;
}

export interface DockerProfile {
  kind: "docker";
  id: string;
  name: string;
  folder?: string;
  containerId: string;
  containerName: string;
  /** MySQL port inside the container, usually 3306. */
  internalPort: number;
  user: string;
  password: string;
  database?: string;
}

export type Profile = DirectProfile | K8sProfile | SshProfile | DockerProfile;

export interface TableFilter {
  include: string[];
  exclude: string[];
  ignoreColumns?: string[];
}

export interface SyncPair {
  id: string;
  name: string;
  sourceProfileId: string;
  targetProfileId: string;
  filter?: TableFilter;
}

export interface VaultData {
  version: 1;
  profiles: Profile[];
  pairs: SyncPair[];
}

export function emptyVault(): VaultData {
  return { version: 1, profiles: [], pairs: [] };
}
