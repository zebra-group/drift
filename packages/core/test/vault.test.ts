import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Vault } from "../src/vault/index.js";

function tmpPath() {
  return join(tmpdir(), `vault-test-${randomUUID()}.db-mirror`);
}

describe("Vault", () => {
  it("creates, saves, and reopens with the same passphrase", async () => {
    const path = tmpPath();
    const v = await Vault.create(path, "s3cret");
    await v.upsertProfile({
      kind: "direct",
      name: "prod",
      host: "db.example.com",
      port: 3306,
      user: "app",
      password: "pw",
    });
    const reopened = await Vault.open(path, "s3cret");
    expect(reopened.listProfiles()).toHaveLength(1);
    expect(reopened.listProfiles()[0]!.name).toBe("prod");
  });

  it("rejects wrong passphrase", async () => {
    const path = tmpPath();
    await Vault.create(path, "right");
    await expect(Vault.open(path, "wrong")).rejects.toThrow(/invalid passphrase/);
  });

  it("preserves profile ids on update", async () => {
    const path = tmpPath();
    const v = await Vault.create(path, "pw");
    const p = await v.upsertProfile({
      kind: "direct",
      name: "a",
      host: "h",
      port: 3306,
      user: "u",
      password: "p",
    });
    const updated = await v.upsertProfile({ ...p, name: "a-renamed" });
    expect(updated.id).toBe(p.id);
    expect(v.listProfiles()).toHaveLength(1);
  });
});
