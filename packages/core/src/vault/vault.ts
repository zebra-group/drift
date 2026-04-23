import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";
import { emptyVault, type Profile, type SyncPair, type VaultData } from "./types.js";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type ProfileInput = DistributiveOmit<Profile, "id"> & { id?: string };

export class Vault {
  private constructor(
    private readonly path: string,
    private passphrase: string,
    private data: VaultData,
  ) {}

  static async create(path: string, passphrase: string): Promise<Vault> {
    await mkdir(dirname(path), { recursive: true });
    const v = new Vault(path, passphrase, emptyVault());
    await v.save();
    return v;
  }

  static async open(path: string, passphrase: string): Promise<Vault> {
    const blob = await readFile(path);
    const json = decrypt(blob, passphrase).toString("utf8");
    const data = JSON.parse(json) as VaultData;
    if (data.version !== 1) throw new Error(`vault: unsupported version ${data.version}`);
    return new Vault(path, passphrase, data);
  }

  static async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  getData(): Readonly<VaultData> {
    return this.data;
  }

  listProfiles(): readonly Profile[] {
    return this.data.profiles;
  }

  getProfile(idOrName: string): Profile | undefined {
    return this.data.profiles.find((p) => p.id === idOrName || p.name === idOrName);
  }

  async upsertProfile(profile: ProfileInput): Promise<Profile> {
    const id = profile.id ?? randomUUID();
    const existing = this.data.profiles.findIndex((p) => p.id === id);
    const full = { ...profile, id } as Profile;
    if (existing >= 0) this.data.profiles[existing] = full;
    else this.data.profiles.push(full);
    await this.save();
    return full;
  }

  async removeProfile(id: string): Promise<void> {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    await this.save();
  }

  listPairs(): readonly SyncPair[] {
    return this.data.pairs;
  }

  async upsertPair(pair: Omit<SyncPair, "id"> & { id?: string }): Promise<SyncPair> {
    const id = pair.id ?? randomUUID();
    const existing = this.data.pairs.findIndex((p) => p.id === id);
    const full: SyncPair = { ...pair, id };
    if (existing >= 0) this.data.pairs[existing] = full;
    else this.data.pairs.push(full);
    await this.save();
    return full;
  }

  async changePassphrase(newPassphrase: string): Promise<void> {
    this.passphrase = newPassphrase;
    await this.save();
  }

  private async save(): Promise<void> {
    const blob = encrypt(Buffer.from(JSON.stringify(this.data), "utf8"), this.passphrase);
    await writeFile(this.path, blob, { mode: 0o600 });
  }
}
