import crypto from 'node:crypto';
import { HTTPError, clientIP } from './http.js';

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createAuth({ db, config }) {
  const failures = new Map();

  function cleanupFailures(now) {
    for (const [ip, entry] of failures) {
      entry.times = entry.times.filter(time => now - time < 10 * 60_000);
      if (entry.times.length === 0) failures.delete(ip);
    }
  }

  function loginAllowed(ip) {
    const now = Date.now();
    cleanupFailures(now);
    const entry = failures.get(ip);
    return !entry || entry.times.length < 10;
  }

  function recordFailure(ip) {
    const entry = failures.get(ip) || { times: [] };
    entry.times.push(Date.now());
    failures.set(ip, entry);
  }

  function clearFailures(ip) {
    failures.delete(ip);
  }

  function verifyCredentials(username, password) {
    return safeEqual(username, config.adminUser) && safeEqual(password, config.adminPassword);
  }

  function issueSession({ ip, userAgent }) {
    const token = crypto.randomBytes(48).toString('base64url');
    const now = Date.now();
    const expiresAt = now + config.sessionHours * 60 * 60_000;
    db.createSession({
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      ip,
      userAgent: userAgent || ''
    });
    return { token, expiresAt };
  }

  function bearer(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice(7).trim();
    }
    const legacy = req.headers['x-admin-token'];
    return typeof legacy === 'string' ? legacy.trim() : '';
  }

  function requireAdmin(req) {
    const token = bearer(req);
    if (!token) throw new HTTPError(401, 'Admin authentication required');

    if (config.adminToken && safeEqual(token, config.adminToken)) {
      return { actor: 'static-token', tokenHash: null };
    }

    const hash = tokenHash(token);
    const session = db.getSession(hash);
    const now = Date.now();
    if (!session || session.expires_at <= now) {
      if (session) db.deleteSession(hash);
      throw new HTTPError(401, 'Admin session is invalid or expired');
    }

    if (now - session.last_seen_at > 5 * 60_000) db.touchSession(hash, now);
    return { actor: config.adminUser, tokenHash: hash };
  }

  function loginContext(req) {
    const ip = clientIP(req, config.trustProxy);
    if (!loginAllowed(ip)) throw new HTTPError(429, 'Too many login attempts. Try again later.');
    return {
      ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
    };
  }

  return {
    verifyCredentials,
    issueSession,
    requireAdmin,
    loginContext,
    recordFailure,
    clearFailures,
    tokenHash
  };
}
