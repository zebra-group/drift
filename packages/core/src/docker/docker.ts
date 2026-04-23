import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  ports: { internal: number; external: number }[];
}

export async function listMysqlContainers(): Promise<DockerContainer[]> {
  try {
    const { stdout } = await execAsync("docker", [
      "ps",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}",
    ], { timeout: 5000 });

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line): DockerContainer[] => {
        const parts = line.split("\t");
        const [id, name, image] = parts;
        const portsStr = parts[3] ?? "";
        const imageLC = image.toLowerCase();
        if (!imageLC.includes("mysql") && !imageLC.includes("mariadb")) return [];
        return [{ id: id.slice(0, 12), name, image, ports: parseDockerPorts(portsStr) }];
      });
  } catch {
    return [];
  }
}

function parseDockerPorts(portsStr: string): { internal: number; external: number }[] {
  const result: { internal: number; external: number }[] = [];
  for (const part of portsStr.split(", ")) {
    const m = part.match(/(?:[\d.]+:)?(\d+)->(\d+)\/tcp/);
    if (m) result.push({ external: parseInt(m[1]), internal: parseInt(m[2]) });
  }
  return result;
}

export async function getContainerPort(containerId: string, internalPort: number): Promise<number> {
  const { stdout } = await execAsync("docker", ["port", containerId, String(internalPort)], { timeout: 5000 });
  const m = stdout.match(/:(\d+)/);
  if (!m) throw new Error(`No port mapping found for container ${containerId}:${internalPort}`);
  return parseInt(m[1]);
}

export async function getContainerEnvs(containerId: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execAsync("docker", [
      "inspect", "--format", "{{json .Config.Env}}", containerId,
    ], { timeout: 5000 });
    const envArray: string[] = JSON.parse(stdout.trim());
    const result: Record<string, string> = {};
    for (const entry of envArray) {
      const idx = entry.indexOf("=");
      if (idx > 0) result[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return result;
  } catch {
    return {};
  }
}
