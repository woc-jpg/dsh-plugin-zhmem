// Local HTTP server for the standalone build.
//
// This is the same code the plugin exposes to an agent - it just talks HTTP
// instead of MCP/ctx.tools, so a user who downloaded the zip and double-clicked
// 启动.bat gets the identical retrieval behaviour without any host around it.
// One source of truth matters here: if the two surfaces drifted, "it works in
// the plugin but not in the window" would become a permanent support burden.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZhmemRuntime, createTools } from './lib/tools.js';
import { VERSION } from './lib/store.js';
import { describe } from './lib/kb.js';
import { loadEnvFile } from './lib/config.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const MAX_BODY = 16 * 1024 * 1024;

// `node server.js` should honour the same zhmem.env the launcher reads - people
// who skip the window and run the service directly are not a different audience.
loadEnvFile(HERE, { silent: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * Start the server. Returns the http.Server so the launcher can close it when
 * the browser window goes away, and tests can close it in a finally block.
 */
export async function startServer({ port = 0, host = '127.0.0.1', dbPath = null, offline = false, webThreshold } = {}) {
  const runtime = new ZhmemRuntime({ dbPath, offline, webThreshold });
  const tools = new Map(createTools(runtime).map((t) => [t.name, t]));

  // Touch the store once up front: seeding 84 entries on the first request
  // would make the UI look frozen for a second or two, and the launcher polls
  // /api/status for liveness - it should not answer "ok" before the data exists.
  const counts = runtime.store.counts();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

    try {
      if (url.pathname === '/api/status') {
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          db: runtime.dbPath,
          offline: runtime.offline,
          counts,
          tools: [...tools.keys()],
          chat: runtime.chat.describe(),
          files: runtime.files.stats(),
        });
      }

      if (url.pathname === '/api/stats') {
        return sendJson(res, 200, { ok: true, ...describe(runtime.store), version: VERSION, db: runtime.dbPath });
      }

      // Conversation and file search get their own routes rather than going
      // through the generic tool dispatcher: they take a session and return
      // structured sources, and the UI needs the pieces (not a pre-rendered
      // markdown blob) to lay out a chat transcript.
      if (url.pathname === '/api/chat') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const body = await readBody(req);
        const result = await runtime.chat.send({
          session: body.session || 'default',
          text: body.text,
          useFiles: body.use_files !== false,
          images: body.images === true,
          ...(body.web_mode === 'always' ? { useWeb: true } : body.web_mode === 'never' ? { useWeb: false } : {}),
        });
        return sendJson(res, 200, { ok: true, result });
      }

      if (url.pathname === '/api/chat/history') {
        const session = url.searchParams.get('session') || 'default';
        return sendJson(res, 200, {
          ok: true,
          session,
          messages: runtime.messages.all(session),
          sessions: runtime.messages.sessions(),
          mode: runtime.chat.describe(),
        });
      }

      if (url.pathname === '/api/chat/clear') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const body = await readBody(req);
        runtime.messages.clear(body.session || 'default');
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/files/stats') {
        return sendJson(res, 200, { ok: true, ...runtime.files.stats() });
      }

      if (url.pathname === '/api/files/index') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const body = await readBody(req);
        if (!body.path) return sendJson(res, 400, { ok: false, error: '要给一个目录路径' });
        const result = runtime.files.index(body.path, { force: body.force === true });
        return sendJson(res, 200, { ok: true, result });
      }

      if (url.pathname === '/api/files/search') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const body = await readBody(req);
        const hits = runtime.files.search(body.query ?? '', {
          limit: Number.isFinite(body.limit) ? body.limit : 8,
          root: body.root ?? null,
        });
        return sendJson(res, 200, { ok: true, hits });
      }

      if (url.pathname === '/api/files/forget') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const body = await readBody(req);
        const removed = runtime.files.forget(body.root);
        return sendJson(res, 200, { ok: true, removed });
      }

      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
        const name = url.pathname.slice('/api/'.length);
        const tool = tools.get(name);
        if (!tool) return sendJson(res, 404, { ok: false, error: `没有这个接口：${name}` });
        const args = await readBody(req);
        const result = await tool.execute(args, {});
        return sendJson(res, 200, { ok: true, result });
      }

      // Static files. `normalize` then prefix check keeps ../ out of the way -
      // the server is loopback-only, but a path traversal bug in a local tool is
      // still a path traversal bug.
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
      const body = await readFile(file);
      return send(res, 200, body, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    } catch (error) {
      if (error.code === 'ENOENT') return send(res, 404, 'not found');
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  return {
    server,
    runtime,
    port: typeof address === 'object' && address ? address.port : port,
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          runtime.close();
          resolve();
        });
      });
    },
  };
}

// Direct invocation: `node server.js` for people who want to run the service
// themselves (or behind their own reverse proxy) without the launcher.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const port = Number(process.env.PORT ?? 8570);
  const app = await startServer({ port, dbPath: process.env.ZHMEM_DB ?? null, offline: process.env.ZHMEM_OFFLINE === '1' });
  console.log(`zhmem ${VERSION} listening on http://127.0.0.1:${app.port}`);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default startServer;
