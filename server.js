// Ephemeral File Relay — a tiny zero-dependency Node server.
// Receives a file, keeps it ONLY in RAM, serves it at a public URL for a few
// minutes (so Base44's InvokeLLM can fetch it), then deletes it automatically.
// Nothing is written to disk. Restart = everything gone.

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const TTL_SECONDS = parseInt(process.env.TTL_SECONDS || '600', 10);
const MAX_FILE_MB = parseFloat(process.env.MAX_FILE_MB || '15');
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '500', 10);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/$/, '');

if (!UPLOAD_TOKEN) {
  console.error('FATAL: UPLOAD_TOKEN env var is required. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// id -> { buffer, contentType, fileName, createdAt, timer }
const store = new Map();

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function randomId() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars = 192 bits
}

function evict(id) {
  const entry = store.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  store.delete(id);
}

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  // constant-time-ish compare
  if (auth.length !== `Bearer ${UPLOAD_TOKEN}`.length) return false;
  return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${UPLOAD_TOKEN}`));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); } catch { return sendJson(res, 400, { error: 'bad_request' }); }
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true, entries: store.size, ttlSeconds: TTL_SECONDS });
  }

  // Upload: raw file bytes in the body. Authorization: Bearer <UPLOAD_TOKEN>.
  // Optional header X-File-Name. Content-Type is preserved for serving.
  if (req.method === 'POST' && path === '/upload') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const fileName = req.headers['x-file-name'] || 'upload';
    const chunks = [];
    let size = 0;
    const cap = MAX_FILE_MB * 1024 * 1024;
    let tooLarge = false;

    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        tooLarge = true;
        req.destroy();
        return sendJson(res, 413, { error: 'too_large', maxMb: MAX_FILE_MB });
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (tooLarge) return;
      if (store.size >= MAX_ENTRIES) {
        // evict the oldest entry to make room
        let oldestId = null, oldestTs = Infinity;
        for (const [k, v] of store) { if (v.createdAt < oldestTs) { oldestTs = v.createdAt; oldestId = k; } }
        if (oldestId) evict(oldestId);
      }
      const id = randomId();
      const timer = setTimeout(() => evict(id), TTL_SECONDS * 1000);
      store.set(id, { buffer: Buffer.concat(chunks), contentType, fileName, createdAt: Date.now(), timer });
      const fileUrl = PUBLIC_BASE ? `${PUBLIC_BASE}/f/${id}` : `/f/${id}`;
      return sendJson(res, 200, { id, url: fileUrl, expiresInSeconds: TTL_SECONDS });
    });

    req.on('error', () => sendJson(res, 400, { error: 'bad_request' }));
    return;
  }

  // Immediate delete. Authorization: Bearer <UPLOAD_TOKEN>.
  if (req.method === 'POST' && path.startsWith('/delete/')) {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const id = path.slice('/delete/'.length);
    if (!store.has(id)) return sendJson(res, 404, { error: 'not_found' });
    evict(id);
    return sendJson(res, 200, { ok: true });
  }

  // Public fetch (the URL InvokeLLM will GET). The unguessable id is the gate.
  if (req.method === 'GET' && path.startsWith('/f/')) {
    const id = path.slice('/f/'.length);
    const entry = store.get(id);
    if (!entry) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.buffer.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(entry.buffer);
  }

  return sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`ephemeral-file-relay listening on :${PORT} | ttl=${TTL_SECONDS}s | max=${MAX_FILE_MB}MB | entries<=${MAX_ENTRIES} | publicBase=${PUBLIC_BASE || '(relative)'}`);
});
