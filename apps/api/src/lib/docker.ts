import http from 'node:http';
import { accessSync } from 'node:fs';

// DOCKER_API_URL may be:
//   unix:///var/run/docker.sock  (local dev, direct socket)
//   http://docker-proxy:2375     (prod, via tecnativa/docker-socket-proxy)
// The proxy exposes only GET /containers/* because POST/exec/create are
// denied upstream — keep this module free of any write endpoints so a
// later accidental call cannot be satisfied by relaxing the proxy.
const DOCKER_API_URL = process.env.DOCKER_API_URL ?? 'unix:///var/run/docker.sock';

// Only containers whose name starts with one of these prefixes are exposed
// to the admin log viewer. Prevents admins from reading logs of unrelated
// host containers (e.g., the shared chainalert Postgres/Redis/nginx).
const ALLOWED_PREFIXES = (process.env.ADMIN_LOGS_ALLOWED_PREFIXES ?? 'sentinel-')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Target =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'http'; hostname: string; port: number };

function parseTarget(url: string): Target {
  if (url.startsWith('unix://')) {
    return { kind: 'unix', socketPath: url.slice('unix://'.length) };
  }
  const u = new URL(url);
  return {
    kind: 'http',
    hostname: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
  };
}

const TARGET = parseTarget(DOCKER_API_URL);

function dockerRequest(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions =
      TARGET.kind === 'unix'
        ? { socketPath: TARGET.socketPath, path, method: 'GET' }
        : { hostname: TARGET.hostname, port: TARGET.port, path, method: 'GET' };

    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`docker api ${res.statusCode}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface LogEntry {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface FetchLogsOpts {
  containerId: string;
  // containerName is required so fetchContainerLogs can re-check the
  // prefix allowlist itself. Callers must pass the name resolved from
  // listContainers — never from untrusted client input.
  containerName: string;
  tail?: number;
  since?: string;
  stream?: 'all' | 'stdout' | 'stderr';
}

export function isDockerAvailable(): boolean {
  if (TARGET.kind === 'unix') {
    try {
      accessSync(TARGET.socketPath);
      return true;
    } catch {
      return false;
    }
  }
  // For HTTP targets we can't cheaply probe synchronously; requests will
  // surface a clear error if the proxy is down.
  return true;
}

function isAllowedName(name: string): boolean {
  return ALLOWED_PREFIXES.some((p) => name.startsWith(p));
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const buf = await dockerRequest('/containers/json');
  const containers = JSON.parse(buf.toString()) as Array<{
    Id: string;
    Names: string[];
    Image: string;
    State: string;
    Status: string;
  }>;

  return containers
    .map((c) => ({
      id: c.Id.slice(0, 12),
      name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
    }))
    .filter((c) => isAllowedName(c.name));
}

// Docker multiplexed stream frame:
//   byte 0: stream type (1=stdout, 2=stderr); bytes 1-3 padding;
//   bytes 4-7: payload size (big-endian uint32); then payload bytes.
function parseMultiplexedStream(buf: Buffer): LogEntry[] {
  const entries: LogEntry[] = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const payloadSize = buf.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + payloadSize > buf.length) break;

    const payload = buf.subarray(offset, offset + payloadSize).toString('utf-8');
    offset += payloadSize;

    const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';

    for (const line of payload.split('\n')) {
      if (!line) continue;
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx > 0 && line[0] >= '0' && line[0] <= '9') {
        entries.push({
          timestamp: line.slice(0, spaceIdx),
          stream,
          message: line.slice(spaceIdx + 1),
        });
      } else {
        entries.push({ timestamp: '', stream, message: line });
      }
    }
  }

  return entries;
}

export async function fetchContainerLogs(opts: FetchLogsOpts): Promise<LogEntry[]> {
  const { containerId, containerName, tail = 200, since, stream = 'all' } = opts;

  if (!isAllowedName(containerName)) {
    throw new Error(`container "${containerName}" is not in the admin-logs allowlist`);
  }

  const params = new URLSearchParams({
    timestamps: '1',
    tail: String(Math.min(tail, 5000)),
  });

  if (stream === 'stdout' || stream === 'all') params.set('stdout', '1');
  if (stream === 'stderr' || stream === 'all') params.set('stderr', '1');
  if (stream === 'stdout') params.set('stderr', '0');
  if (stream === 'stderr') params.set('stdout', '0');

  if (since) {
    const ts = Math.floor(new Date(since).getTime() / 1000);
    if (!isNaN(ts)) params.set('since', String(ts));
  }

  const buf = await dockerRequest(`/containers/${containerId}/logs?${params}`);
  return parseMultiplexedStream(buf);
}
