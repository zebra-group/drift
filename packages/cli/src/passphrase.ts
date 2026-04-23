import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export async function readPassphrase(opts: { file?: string; promptLabel?: string }): Promise<string> {
  if (process.env.DB_MIRROR_PASSPHRASE) return process.env.DB_MIRROR_PASSPHRASE;
  if (opts.file) return (await readFile(opts.file, "utf8")).trim();
  return promptSecret(opts.promptLabel ?? "Master passphrase: ");
}

function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
    const origWrite = stdout._writeToOutput?.bind(stdout);
    // Mute echo
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(label)) process.stdout.write(s);
      else process.stdout.write("");
    };
    rl.question(label, (answer) => {
      if (origWrite) stdout._writeToOutput = origWrite;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}
