import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

const MAGIC = Buffer.from("DBMV1\0", "utf8");
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface EncryptedBlob {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: 128 * 1024 * 1024 });
}

export function encrypt(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

export function decrypt(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error("vault: blob too short");
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("vault: bad magic / unsupported format");
  }
  let o = MAGIC.length;
  const salt = blob.subarray(o, (o += SALT_LEN));
  const iv = blob.subarray(o, (o += IV_LEN));
  const tag = blob.subarray(o, (o += TAG_LEN));
  const ciphertext = blob.subarray(o);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("vault: invalid passphrase or corrupted file");
  }
}
