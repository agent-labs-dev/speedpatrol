import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardData } from './data.js';

export type DashboardOptions = {
  /** The `.speedpatrol` folder. */
  configDir: string;
  /** Default 4321. 0 picks a free port. */
  port?: number;
  /** Loopback by default: run data names hosts, commits and code paths. */
  host?: string;
};

export type Dashboard = { url: string; close(): Promise<void> };

/**
 * `<package>/dist/server.js` -> `<package>/src/ui`. The bundled CLI copies the
 * folder to `packages/speedpatrol/src/ui` next to its own `dist/bin.js`, so the
 * same relative step finds it there too.
 */
const UI_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Run, comparison and session ids are file names: no separators, no dot-dot. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const data = new DashboardData(resolve(options.configDir));
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    handle(req, res, data).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    });
  });
  const port = await listen(server, options.port ?? 4321, host);
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  };
}

function id(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed id');
  }
  if (!SAFE_ID.test(value) || value.includes('..')) throw new HttpError(400, 'invalid id');
  return value;
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new HttpError(404, `no such ${what}`);
  return value;
}

async function handle(req: IncomingMessage, res: ServerResponse, data: DashboardData): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'read-only');
  // The raw path, not a URL-normalised one: `/api/runs/../x` must be refused, not quietly resolved.
  const raw = (req.url ?? '/').split('?')[0]!;
  const parts = raw.split('/').slice(1);
  if (parts[0] !== 'api') return serveUi(res, raw);

  const [, resource, key, sub, ...rest] = parts;
  if (rest.length) throw new HttpError(404, 'not found');
  switch (resource) {
    case 'summary':
      return json(res, await data.summary());
    case 'agents':
      return json(res, await data.agentsAndPatrol());
    case 'benchmarks':
      // Benchmark ids are looked up in run data, never used as paths, but hold them to the same alphabet.
      return json(res, key ? found(await data.benchmark(id(key)), 'benchmark') : await data.benchmarks());
    case 'runs':
      return json(res, key ? found(await data.store.getRun(id(key)), 'run') : await data.runs());
    case 'comparisons':
      return json(res, key ? found(await data.store.getComparison(id(key)), 'comparison') : await data.comparisons());
    case 'regressions':
      return json(res, await data.regressions());
    case 'experiments':
      return json(res, await data.experiments());
    case 'sessions':
      if (!key) return json(res, await data.sessions());
      if (sub !== 'events') throw new HttpError(404, 'not found');
      return json(res, await data.store.events(id(key)));
    default:
      throw new HttpError(404, 'not found');
  }
}

function serveUi(res: ServerResponse, raw: string): void {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed path');
  }
  if (path.split(/[/\\]/).includes('..')) throw new HttpError(400, 'invalid path');
  const file = resolve(UI_DIR, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!file.startsWith(UI_DIR + sep)) throw new HttpError(400, 'invalid path');
  // Unknown paths get the app shell; routing is in the hash, so this is only a soft landing.
  const target = existsSync(file) && statSync(file).isFile() ? file : resolve(UI_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'text/plain', 'cache-control': 'no-cache' });
  createReadStream(target).pipe(res);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done((server.address() as { port: number }).port);
    });
  });
}
