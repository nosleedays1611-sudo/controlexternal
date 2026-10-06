import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HTTPError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HTTPError';
    this.status = status;
    this.details = details;
  }
}

export function sendJSON(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers
  });
  res.end(body);
}

export function sendEmpty(res, status = 204, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

export async function readJSON(req, maxBytes) {
  const raw = await readBuffer(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HTTPError(400, 'Invalid JSON body');
  }
}

export function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HTTPError(413, `Body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

export async function streamUploadToFile(req, destination, maxBytes) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });

  let size = 0;
  let settled = false;

  return await new Promise((resolve, reject) => {
    const fail = async error => {
      if (settled) return;
      settled = true;
      output.destroy();
      try { await fs.promises.rm(temp, { force: true }); } catch {}
      reject(error);
    };

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        void fail(new HTTPError(413, `Patch exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      hash.update(chunk);
      if (!output.write(chunk)) req.pause();
    });

    output.on('drain', () => req.resume());
    req.on('error', error => void fail(error));
    output.on('error', error => void fail(error));

    req.on('end', () => {
      if (settled) return;
      output.end(async () => {
        if (settled) return;
        try {
          if (size === 0) throw new HTTPError(400, 'Patch body is empty');
          await fs.promises.rename(temp, destination);
          settled = true;
          resolve({ size, sha256: hash.digest('hex') });
        } catch (error) {
          void fail(error);
        }
      });
    });
  });
}

export function clientIP(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

export function setCommonHeaders(req, res, allowedOrigins) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token, X-Patch-File-Name, X-Patch-Password, X-Patch-Note');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  }
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

export async function serveStatic(publicDir, pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) return false;
  const resolved = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir) + path.sep;
  if (!resolved.startsWith(root)) return false;

  let stat;
  try { stat = await fs.promises.stat(resolved); } catch { return false; }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': MIME.get(path.extname(resolved).toLowerCase()) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}
