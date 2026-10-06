import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { Store } from './database.js';
import { createAuth } from './lib/auth.js';
import {
  HTTPError,
  clientIP,
  readJSON,
  sendEmpty,
  sendJSON,
  serveStatic,
  setCommonHeaders,
  streamUploadToFile
} from './lib/http.js';
import {
  ValidationError,
  featureCreate,
  featurePatch,
  id,
  loginBody,
  patchCreate,
  patchMetadata,
  rollbackBody,
  settingsPatch,
  tabCreate,
  tabPatch
} from './lib/validation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const db = new Store(config);
const auth = createAuth({ db, config });
const uploadLocks = new Set();

if (!config.adminPassword && !config.adminToken) {
  throw new Error('Set ADMIN_PASSWORD or ADMIN_TOKEN before starting the server.');
}

function nowISO() { return new Date().toISOString(); }

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function requestContext(req) {
  return { ip: clientIP(req, config.trustProxy) };
}

function admin(req) {
  return auth.requireAdmin(req);
}

function audit(req, eventType, actor, details = {}) {
  db.audit(eventType, actor, clientIP(req, config.trustProxy), details);
}

function conflict(res, message, details) {
  sendJSON(res, 409, { ok: false, error: message, details });
}

async function handle(req, res) {
  setCommonHeaders(req, res, config.allowedOrigins);
  if (req.method === 'OPTIONS') return sendEmpty(res, 204);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'external-remote-server',
      version: '2.0.0',
      time: nowISO(),
      revision: db.revision(),
      publishedPatches: db.adminState().stats.publishedPatches
    }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && pathname === '/api/config/revision') {
    return sendJSON(res, 200, { revision: db.revision() }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const payload = db.publicConfig();
    const body = JSON.stringify(payload);
    const etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendJSON(res, 200, payload, {
      ETag: etag,
      'Cache-Control': 'no-store',
      'X-External-Revision': String(payload.revision)
    });
  }

  let m = routeMatch(pathname, /^\/api\/patches\/([^/]+)$/);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const patchID = id(m[0]);
    const patch = db.getPatch(patchID);
    if (!patch || patch.current_version <= 0 || !patch.storage_path) {
      throw new HTTPError(404, 'Patch is not published');
    }
    const filePath = db.absoluteStoragePath(patch.storage_path);
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch { throw new HTTPError(404, 'Published patch file is missing'); }
    if (!stat.isFile() || stat.size !== patch.size) throw new HTTPError(500, 'Published patch storage is inconsistent');

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${patch.file_name.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ETag: `"${patch.sha256}"`,
      'X-Patch-ID': patch.id,
      'X-Patch-Version': String(patch.current_version),
      'X-Patch-SHA256': patch.sha256
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const ctx = auth.loginContext(req);
    const body = loginBody(await readJSON(req, config.maxJSONBytes));
    if (!auth.verifyCredentials(body.username, body.password)) {
      auth.recordFailure(ctx.ip);
      db.audit('admin.login.failed', body.username, ctx.ip, {});
      throw new HTTPError(401, 'Invalid username or password');
    }
    auth.clearFailures(ctx.ip);
    const session = auth.issueSession(ctx);
    db.audit('admin.login.success', body.username, ctx.ip, { expiresAt: session.expiresAt });
    return sendJSON(res, 200, {
      ok: true,
      token: session.token,
      tokenType: 'Bearer',
      expiresAt: session.expiresAt,
      username: config.adminUser
    }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const who = admin(req);
    if (who.tokenHash) db.deleteSession(who.tokenHash);
    audit(req, 'admin.logout', who.actor);
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/admin/state') {
    admin(req);
    return sendJSON(res, 200, { ok: true, ...db.adminState() }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    admin(req);
    const requested = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 1000) : 100;
    return sendJSON(res, 200, { ok: true, events: db.auditList(limit) }, { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'PATCH' && pathname === '/api/admin/settings') {
    const who = admin(req);
    const body = settingsPatch(await readJSON(req, config.maxJSONBytes));
    const result = db.setPollInterval(body.pollIntervalSeconds);
    audit(req, 'settings.updated', who.actor, body);
    return sendJSON(res, 200, { ok: true, revision: result.revision, ...body });
  }

  if (req.method === 'POST' && pathname === '/api/admin/tabs') {
    const who = admin(req);
    const tab = tabCreate(await readJSON(req, config.maxJSONBytes));
    try {
      const revision = db.createTab(tab);
      audit(req, 'tab.created', who.actor, { id: tab.id });
      return sendJSON(res, 201, { ok: true, revision, tab });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) throw new HTTPError(409, 'Tab already exists');
      throw error;
    }
  }

  m = routeMatch(pathname, /^\/api\/admin\/tabs\/([^/]+)$/);
  if (m && req.method === 'PATCH') {
    const who = admin(req);
    const tabID = id(m[0]);
    const patch = tabPatch(await readJSON(req, config.maxJSONBytes));
    const result = db.updateTab(tabID, patch);
    if (!result) throw new HTTPError(404, 'Tab not found');
    audit(req, 'tab.updated', who.actor, { id: tabID, changes: patch });
    return sendJSON(res, 200, { ok: true, ...result });
  }

  if (m && req.method === 'DELETE') {
    const who = admin(req);
    const tabID = id(m[0]);
    const cascade = ['1', 'true', 'yes'].includes((url.searchParams.get('cascade') || '').toLowerCase());
    const result = db.deleteTab(tabID, cascade);
    if (result.missing) throw new HTTPError(404, 'Tab not found');
    if (result.conflict) return conflict(res, 'Tab still has features', { featureIDs: result.conflict });
    audit(req, 'tab.deleted', who.actor, { id: tabID, cascade });
    return sendJSON(res, 200, { ok: true, revision: result.revision });
  }

  if (req.method === 'POST' && pathname === '/api/admin/features') {
    const who = admin(req);
    const feature = featureCreate(await readJSON(req, config.maxJSONBytes));
    try {
      const result = db.createFeature(feature);
      if (result.missingTab) throw new HTTPError(400, 'tabID does not exist');
      if (result.missingPatches) throw new HTTPError(400, 'One or more patch IDs do not exist', { patchIDs: result.missingPatches });
      audit(req, 'feature.created', who.actor, { id: feature.id });
      return sendJSON(res, 201, { ok: true, revision: result.revision, feature });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) throw new HTTPError(409, 'Feature already exists');
      throw error;
    }
  }

  m = routeMatch(pathname, /^\/api\/admin\/features\/([^/]+)$/);
  if (m && req.method === 'PATCH') {
    const who = admin(req);
    const featureID = id(m[0]);
    const patch = featurePatch(await readJSON(req, config.maxJSONBytes));
    const result = db.updateFeature(featureID, patch);
    if (!result) throw new HTTPError(404, 'Feature not found');
    if (result.missingTab) throw new HTTPError(400, 'tabID does not exist');
    if (result.missingPatches) throw new HTTPError(400, 'One or more patch IDs do not exist', { patchIDs: result.missingPatches });
    audit(req, 'feature.updated', who.actor, { id: featureID, changes: patch });
    return sendJSON(res, 200, { ok: true, ...result });
  }

  if (m && req.method === 'DELETE') {
    const who = admin(req);
    const featureID = id(m[0]);
    const result = db.deleteFeature(featureID);
    if (!result) throw new HTTPError(404, 'Feature not found');
    audit(req, 'feature.deleted', who.actor, { id: featureID });
    return sendJSON(res, 200, { ok: true, revision: result.revision });
  }

  if (req.method === 'POST' && pathname === '/api/admin/patches') {
    const who = admin(req);
    const patch = patchCreate(await readJSON(req, config.maxJSONBytes));
    try {
      const result = db.createPatch(patch);
      audit(req, 'patch.created', who.actor, { id: patch.id });
      return sendJSON(res, 201, { ok: true, revision: result.revision, patch });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) throw new HTTPError(409, 'Patch already exists');
      throw error;
    }
  }

  m = routeMatch(pathname, /^\/api\/admin\/patches\/([^/]+)$/);
  if (m && req.method === 'PATCH') {
    const who = admin(req);
    const patchID = id(m[0]);
    const patch = patchMetadata(await readJSON(req, config.maxJSONBytes));
    const result = db.updatePatchMetadata(patchID, patch);
    if (!result) throw new HTTPError(404, 'Patch not found');
    audit(req, 'patch.metadata.updated', who.actor, { id: patchID, changes: patch });
    return sendJSON(res, 200, { ok: true, revision: result.revision });
  }

  if (m && req.method === 'DELETE') {
    const who = admin(req);
    const patchID = id(m[0]);
    const result = db.deletePatch(patchID);
    if (result.missing) throw new HTTPError(404, 'Patch not found');
    if (result.conflict) return conflict(res, 'Patch is still referenced by features', { featureIDs: result.conflict });
    for (const relative of result.paths) {
      try { await fs.promises.rm(db.absoluteStoragePath(relative), { force: true }); } catch {}
    }
    try { await fs.promises.rm(path.join(db.patchDir, patchID), { recursive: true, force: true }); } catch {}
    audit(req, 'patch.deleted', who.actor, { id: patchID });
    return sendJSON(res, 200, { ok: true, revision: result.revision });
  }

  m = routeMatch(pathname, /^\/api\/admin\/patches\/([^/]+)\/file$/);
  if (m && req.method === 'PUT') {
    const who = admin(req);
    const patchID = id(m[0]);
    const existing = db.getPatch(patchID);
    if (!existing) throw new HTTPError(404, 'Patch not found');
    if (uploadLocks.has(patchID)) throw new HTTPError(409, 'Another upload for this patch is already running');

    uploadLocks.add(patchID);
    try {
      const version = db.nextPatchVersion(patchID);
      const relative = db.relativePatchPath(patchID, version);
      const destination = db.absoluteStoragePath(relative);
      const fileNameHeader = req.headers['x-patch-file-name'];
      const passwordHeader = req.headers['x-patch-password'];
      const noteHeader = req.headers['x-patch-note'];
      const fileName = typeof fileNameHeader === 'string' && fileNameHeader.trim() ? fileNameHeader.trim() : existing.file_name;
      if (!fileName.toLowerCase().endsWith('.3105')) throw new HTTPError(400, 'X-Patch-File-Name must end in .3105');
      const password = typeof passwordHeader === 'string' ? passwordHeader : existing.password;
      if (Buffer.byteLength(password, 'utf8') > 256) throw new HTTPError(400, 'X-Patch-Password is too long');
      const note = typeof noteHeader === 'string' ? noteHeader.slice(0, 500) : '';

      const expectedLength = req.headers['content-length'] ? Number.parseInt(req.headers['content-length'], 10) : null;
      if (expectedLength != null && (!Number.isFinite(expectedLength) || expectedLength <= 0)) throw new HTTPError(400, 'Invalid Content-Length');
      if (expectedLength != null && expectedLength > config.maxPatchBytes) throw new HTTPError(413, 'Patch is too large');

      const uploaded = await streamUploadToFile(req, destination, config.maxPatchBytes);
      try {
        const revision = db.publishPatch({
          patchID, version, fileName, password,
          sha256: uploaded.sha256, size: uploaded.size,
          storagePath: relative, note, actor: who.actor
        });
        audit(req, 'patch.published', who.actor, { id: patchID, version, sha256: uploaded.sha256, size: uploaded.size });
        return sendJSON(res, 201, {
          ok: true,
          revision,
          patch: { id: patchID, fileName, password, version, sha256: uploaded.sha256, size: uploaded.size }
        });
      } catch (error) {
        try { await fs.promises.rm(destination, { force: true }); } catch {}
        throw error;
      }
    } finally {
      uploadLocks.delete(patchID);
    }
  }

  m = routeMatch(pathname, /^\/api\/admin\/patches\/([^/]+)\/versions$/);
  if (m && req.method === 'GET') {
    admin(req);
    const patchID = id(m[0]);
    if (!db.getPatch(patchID)) throw new HTTPError(404, 'Patch not found');
    return sendJSON(res, 200, { ok: true, patchID, versions: db.patchVersions(patchID) }, { 'Cache-Control': 'no-store' });
  }

  m = routeMatch(pathname, /^\/api\/admin\/patches\/([^/]+)\/rollback$/);
  if (m && req.method === 'POST') {
    const who = admin(req);
    const patchID = id(m[0]);
    if (!db.getPatch(patchID)) throw new HTTPError(404, 'Patch not found');
    const body = rollbackBody(await readJSON(req, config.maxJSONBytes));
    const result = db.rollbackPatch(patchID, body.version);
    if (!result) throw new HTTPError(404, 'Patch version not found');
    audit(req, 'patch.rolled_back', who.actor, { id: patchID, version: body.version });
    return sendJSON(res, 200, { ok: true, revision: result.revision, version: body.version });
  }

  m = routeMatch(pathname, /^\/api\/admin\/patches\/([^/]+)\/unpublish$/);
  if (m && req.method === 'POST') {
    const who = admin(req);
    const patchID = id(m[0]);
    const result = db.unpublishPatch(patchID);
    if (!result) throw new HTTPError(404, 'Patch not found');
    audit(req, 'patch.unpublished', who.actor, { id: patchID });
    return sendJSON(res, 200, { ok: true, revision: result.revision });
  }

  if (pathname.startsWith('/api/')) throw new HTTPError(404, 'API route not found');

  if (await serveStatic(publicDir, pathname, res)) return;

  if (pathname === '/') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'external-remote-server',
      message: 'Backend is running. Admin HTML will be added separately.',
      health: '/health',
      config: '/api/config'
    }, { 'Cache-Control': 'no-store' });
  }

  throw new HTTPError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    await handle(req, res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    const status = error instanceof HTTPError ? error.status
      : error instanceof ValidationError ? 400
      : 500;
    const message = status >= 500 ? 'Internal server error' : error.message;
    const details = error.details;
    if (status >= 500) console.error(`[${nowISO()}]`, error);
    sendJSON(res, status, { ok: false, error: message, ...(details === undefined ? {} : { details }) }, { 'Cache-Control': 'no-store' });
  } finally {
    const elapsed = Date.now() - started;
    const ip = clientIP(req, config.trustProxy);
    console.log(`${nowISO()} ${ip} ${req.method} ${req.url} ${res.statusCode || 0} ${elapsed}ms`);
  }
});

server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  console.log(`EXTERNAL Remote Server 2.0 listening on http://${config.host}:${config.port}`);
  console.log(`Data: ${config.dataDir}`);
  console.log(`Revision: ${db.revision()}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
