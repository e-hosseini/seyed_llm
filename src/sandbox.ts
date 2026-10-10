import Docker from "dockerode";
import tar from "tar-stream";
import { PassThrough } from "node:stream";
import { config } from "./config.js";
import type { User } from "./store.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const HOME = "/home/agent";
const AGENT_UID = 1000;

export const containerName = (id: number) => `aggs-${id}`;
const volumeName = (id: number) => `aggs-home-${id}`;
const networkName = (idx: number) => `aggs-net-${idx}`;

const isNotFound = (e: any) => e?.statusCode === 404;

/** Pulls the prebuilt sandbox image. Without `force`, only pulls when it is missing locally. */
export async function ensureImage(force = false): Promise<void> {
  if (!force) {
    try {
      await docker.getImage(config.sandboxImage).inspect();
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  const authconfig =
    config.ghcrToken && config.ghcrUser
      ? { username: config.ghcrUser, password: config.ghcrToken, serveraddress: "ghcr.io" }
      : undefined;
  await new Promise<void>((resolve, reject) => {
    docker.pull(config.sandboxImage, authconfig ? { authconfig } : {}, (err: Error | null, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
  });
}

/** One bridge network per user, with LiteLLM attached so it is the only service the sandbox can reach. */
async function ensureNetwork(idx: number): Promise<void> {
  const name = networkName(idx);
  const net = docker.getNetwork(name);
  let info: any;
  try {
    info = await net.inspect();
  } catch (e) {
    if (!isNotFound(e)) throw e;
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Options: { "com.docker.network.bridge.name": `aggsbr${idx}` },
      Labels: { "aggs.managed": "true" },
    });
    info = await net.inspect();
  }
  const attached = Object.values(info.Containers ?? {}).some((c: any) => c.Name === config.litellmContainer);
  if (!attached) await net.connect({ Container: config.litellmContainer });
}

function sandboxEnv(user: User): string[] {
  return [
    `HOME=${HOME}`,
    "ANTHROPIC_BASE_URL=http://litellm:4000",
    `ANTHROPIC_AUTH_TOKEN=${user.litellm_key}`,
    `ANTHROPIC_MODEL=${config.sandboxModel}`,
    `ANTHROPIC_SMALL_FAST_MODEL=${config.sandboxSmallModel}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${config.sandboxSmallModel}`,
    "DISABLE_AUTOUPDATER=1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
  ];
}

/** Makes sure the user's container exists, carries their current key, and is running. */
export async function ensureReady(user: User): Promise<void> {
  if (!user.litellm_key || user.net_idx == null) throw new Error(`User ${user.telegram_id} is not provisioned`);
  await ensureImage();
  await ensureNetwork(user.net_idx);

  const container = docker.getContainer(containerName(user.telegram_id));
  let info: Docker.ContainerInspectInfo | undefined;
  try {
    info = await container.inspect();
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  // A stale key (after revoke + re-approve) means the container must be recreated.
  if (info && !(info.Config.Env ?? []).includes(`ANTHROPIC_AUTH_TOKEN=${user.litellm_key}`)) {
    await container.remove({ force: true });
    info = undefined;
  }

  if (!info) {
    await docker.createContainer({
      name: containerName(user.telegram_id),
      Image: config.sandboxImage,
      Cmd: ["sleep", "infinity"],
      User: "agent",
      WorkingDir: `${HOME}/workspace`,
      Env: sandboxEnv(user),
      Labels: { "aggs.managed": "true", "aggs.user": String(user.telegram_id) },
      HostConfig: {
        Binds: [`${volumeName(user.telegram_id)}:${HOME}`],
        NetworkMode: networkName(user.net_idx),
        RestartPolicy: { Name: "unless-stopped" },
        Memory: config.memoryBytes,
        MemorySwap: config.memoryBytes,
        NanoCpus: Math.round(config.cpus * 1e9),
        PidsLimit: config.pids,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Init: true,
      },
    });
  }

  const state = (await container.inspect()).State;
  if (!state.Running) await container.start();
}

export async function stopContainer(id: number): Promise<void> {
  try {
    await docker.getContainer(containerName(id)).stop({ t: 5 });
  } catch (e: any) {
    if (!isNotFound(e) && e?.statusCode !== 304) throw e;
  }
}

export async function removeContainer(id: number): Promise<void> {
  try {
    await docker.getContainer(containerName(id)).remove({ force: true });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

export async function containerState(id: number): Promise<string> {
  try {
    const info = await docker.getContainer(containerName(id)).inspect();
    return info.State.Status;
  } catch (e) {
    if (isNotFound(e)) return "missing";
    throw e;
  }
}

/**
 * Runs `claude` inside the user's container. The prompt travels as an env var so nothing
 * needs to be attached to stdin and no shell quoting is involved. The wrapper records its
 * pid so a turn can be interrupted later.
 */
export async function execClaude(
  id: number,
  args: string[],
  prompt: string,
  onStdoutLine: (line: string) => void,
): Promise<{ exitCode: number; stderr: string }> {
  const exec = await docker.getContainer(containerName(id)).exec({
    Cmd: ["sh", "-c", 'echo $$ > /tmp/claude.pid; exec claude "$@" -- "$PROMPT"', "sh", ...args],
    Env: [`PROMPT=${prompt}`],
    User: "agent",
    WorkingDir: `${HOME}/workspace`,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});

  const out = new PassThrough();
  const err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);

  let buf = "";
  out.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onStdoutLine(line);
    }
  });
  let stderr = "";
  err.setEncoding("utf8");
  err.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  if (buf.trim()) onStdoutLine(buf);

  // ExitCode can lag the end of the stream by a moment.
  for (let i = 0; i < 20; i++) {
    const info = await exec.inspect();
    if (!info.Running) return { exitCode: info.ExitCode ?? -1, stderr };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { exitCode: -1, stderr };
}

/** Terminates the running turn, if any. Only signals the pid if it is really a claude process. */
export async function killTurn(id: number): Promise<void> {
  const exec = await docker.getContainer(containerName(id)).exec({
    Cmd: [
      "sh",
      "-c",
      'p=$(cat /tmp/claude.pid 2>/dev/null); [ -n "$p" ] && grep -q claude "/proc/$p/cmdline" 2>/dev/null && kill -TERM "$p"; true',
    ],
    User: "agent",
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  stream.resume();
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
  });
}

/** Copies a file into the user's ~/inbox. Returns the absolute path inside the container. */
export async function putInboxFile(id: number, name: string, data: Buffer): Promise<string> {
  const pack = tar.pack();
  pack.entry({ name, uid: AGENT_UID, gid: AGENT_UID, mode: 0o644 }, data);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  await docker.getContainer(containerName(id)).putArchive(Buffer.concat(chunks), { path: `${HOME}/inbox` });
  return `${HOME}/inbox/${name}`;
}
