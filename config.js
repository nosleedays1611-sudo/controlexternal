import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function integer(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function resolvePath(raw, fallback) {
  const value = raw || fallback;
  return path.isAbsolute(value) ? value : path.resolve(here, value);
}

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 3000, 1, 65535),
  trustProxy: bool('TRUST_PROXY', false),
  publicBaseURL: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  adminUser: process.env.ADMIN_USER || 'nextaway',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  sessionHours: integer('ADMIN_SESSION_HOURS', 12, 1, 168),

  dataDir: resolvePath(process.env.DATA_DIR, './data'),
  seedConfigPath: resolvePath(process.env.SEED_CONFIG, './seed-config.json'),
  maxJSONBytes: integer('MAX_JSON_BYTES', 1_048_576, 1024, 16 * 1024 * 1024),
  maxPatchBytes: integer('MAX_PATCH_BYTES', 64 * 1024 * 1024, 1024, 512 * 1024 * 1024),

  allowedOrigins: new Set(
    (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )
});
