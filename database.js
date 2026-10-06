import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function bool(value) { return value ? 1 : 0; }
function json(value) { return JSON.stringify(value ?? {}); }

export class Store {
  constructor({ dataDir, seedConfigPath }) {
    this.dataDir = dataDir;
    this.patchDir = path.join(dataDir, 'patches');
    fs.mkdirSync(this.patchDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    this.dbPath = path.join(dataDir, 'external-remote.sqlite3');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.migrate();
    this.seed(seedConfigPath);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tabs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        icon TEXT NOT NULL,
        visible INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        password TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL REFERENCES tabs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        slot_id TEXT,
        title TEXT NOT NULL,
        subtitle TEXT,
        category TEXT NOT NULL,
        game TEXT NOT NULL,
        image_name TEXT,
        visible INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        patch_id TEXT REFERENCES patches(id) ON UPDATE CASCADE ON DELETE SET NULL,
        antenna_patch_id TEXT REFERENCES patches(id) ON UPDATE CASCADE ON DELETE SET NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patch_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patch_id TEXT NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        password TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE(patch_id, version)
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip TEXT NOT NULL,
        user_agent TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        ip TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_features_tab ON features(tab_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_patch_versions_patch ON patch_versions(patch_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON admin_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    `);
  }

  seed(seedConfigPath) {
    const initialized = this.getMeta('initialized');
    if (initialized === '1') return;

    const seed = JSON.parse(fs.readFileSync(seedConfigPath, 'utf8'));
    if (seed.schema !== 2) throw new Error('seed-config.json must use schema 2');
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertTab = this.db.prepare(`
        INSERT INTO tabs (id,title,icon,visible,enabled,sort_order,updated_at)
        VALUES (?,?,?,?,?,?,?)
      `);
      const insertPatch = this.db.prepare(`
        INSERT INTO patches (id,file_name,password,current_version,sha256,size,storage_path,updated_at)
        VALUES (?,?,?,?,?,?,NULL,?)
      `);
      const insertFeature = this.db.prepare(`
        INSERT INTO features
          (id,tab_id,slot_id,title,subtitle,category,game,image_name,visible,enabled,sort_order,patch_id,antenna_patch_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      for (const tab of seed.tabs || []) {
        insertTab.run(tab.id, tab.title, tab.icon, bool(tab.visible), bool(tab.enabled), tab.order, now);
      }
      for (const patch of seed.patches || []) {
        insertPatch.run(patch.id, patch.fileName, patch.password ?? '0', 0, '', 0, now);
      }
      for (const feature of seed.features || []) {
        insertFeature.run(
          feature.id, feature.tabID, feature.slotID ?? null, feature.title, feature.subtitle ?? null,
          feature.category, feature.game, feature.imageName ?? null, bool(feature.visible), bool(feature.enabled),
          feature.order, feature.patchID ?? null, feature.withAntennaPatchID ?? null, now
        );
      }

      this.setMeta('schema', '2');
      this.setMeta('revision', String(seed.revision ?? 1));
      this.setMeta('pollIntervalSeconds', String(seed.pollIntervalSeconds ?? 30));
      this.setMeta('initialized', '1');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, String(value));
  }

  revision() { return Number.parseInt(this.getMeta('revision') || '0', 10); }
  pollIntervalSeconds() { return Number.parseInt(this.getMeta('pollIntervalSeconds') || '30', 10); }

  bumpRevision() {
    const next = this.revision() + 1;
    this.setMeta('revision', String(next));
    return next;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  publicConfig() {
    const tabs = this.db.prepare(`
      SELECT id,title,icon,visible,enabled,sort_order FROM tabs
      ORDER BY sort_order ASC, title COLLATE NOCASE ASC
    `).all().map(row => ({
      id: row.id, title: row.title, icon: row.icon,
      visible: !!row.visible, enabled: !!row.enabled, order: row.sort_order
    }));

    const features = this.db.prepare(`
      SELECT id,tab_id,slot_id,title,subtitle,category,game,image_name,visible,enabled,sort_order,patch_id,antenna_patch_id
      FROM features ORDER BY sort_order ASC, title COLLATE NOCASE ASC
    `).all().map(row => ({
      id: row.id,
      tabID: row.tab_id,
      slotID: row.slot_id,
      title: row.title,
      subtitle: row.subtitle,
      category: row.category,
      game: row.game,
      imageName: row.image_name,
      visible: !!row.visible,
      enabled: !!row.enabled,
      order: row.sort_order,
      patchID: row.patch_id,
      withAntennaPatchID: row.antenna_patch_id
    }));

    const patches = this.db.prepare(`
      SELECT id,file_name,password,current_version,sha256,size FROM patches ORDER BY id ASC
    `).all().map(row => ({
      id: row.id,
      fileName: row.file_name,
      password: row.password,
      version: row.current_version,
      sha256: row.sha256,
      size: row.size
    }));

    return {
      schema: 2,
      revision: this.revision(),
      pollIntervalSeconds: this.pollIntervalSeconds(),
      tabs,
      features,
      patches
    };
  }

  adminState() {
    return {
      ...this.publicConfig(),
      stats: {
        tabs: this.db.prepare('SELECT COUNT(*) AS count FROM tabs').get().count,
        features: this.db.prepare('SELECT COUNT(*) AS count FROM features').get().count,
        patches: this.db.prepare('SELECT COUNT(*) AS count FROM patches').get().count,
        publishedPatches: this.db.prepare('SELECT COUNT(*) AS count FROM patches WHERE current_version > 0').get().count,
        patchVersions: this.db.prepare('SELECT COUNT(*) AS count FROM patch_versions').get().count
      }
    };
  }

  getTab(tabID) { return this.db.prepare('SELECT * FROM tabs WHERE id=?').get(tabID) || null; }
  getFeature(featureID) { return this.db.prepare('SELECT * FROM features WHERE id=?').get(featureID) || null; }
  getPatch(patchID) { return this.db.prepare('SELECT * FROM patches WHERE id=?').get(patchID) || null; }

  createTab(tab) {
    const now = Date.now();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO tabs(id,title,icon,visible,enabled,sort_order,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(tab.id, tab.title, tab.icon, bool(tab.visible), bool(tab.enabled), tab.order, now);
      return this.bumpRevision();
    });
  }

  updateTab(tabID, patch) {
    const current = this.getTab(tabID);
    if (!current) return null;
    const next = {
      title: patch.title ?? current.title,
      icon: patch.icon ?? current.icon,
      visible: patch.visible ?? !!current.visible,
      enabled: patch.enabled ?? !!current.enabled,
      order: patch.order ?? current.sort_order
    };
    const revision = this.transaction(() => {
      this.db.prepare(`UPDATE tabs SET title=?,icon=?,visible=?,enabled=?,sort_order=?,updated_at=? WHERE id=?`)
        .run(next.title, next.icon, bool(next.visible), bool(next.enabled), next.order, Date.now(), tabID);
      return this.bumpRevision();
    });
    return { revision, tab: { id: tabID, ...next } };
  }

  deleteTab(tabID, cascade) {
    const tab = this.getTab(tabID);
    if (!tab) return { missing: true };
    const refs = this.db.prepare('SELECT id FROM features WHERE tab_id=? ORDER BY id').all(tabID).map(row => row.id);
    if (refs.length && !cascade) return { conflict: refs };
    const revision = this.transaction(() => {
      if (cascade) this.db.prepare('DELETE FROM features WHERE tab_id=?').run(tabID);
      this.db.prepare('DELETE FROM tabs WHERE id=?').run(tabID);
      return this.bumpRevision();
    });
    return { revision };
  }

  createFeature(feature) {
    if (!this.getTab(feature.tabID)) return { missingTab: true };
    const missingPatches = [feature.patchID, feature.withAntennaPatchID]
      .filter(Boolean)
      .filter(patchID => !this.getPatch(patchID));
    if (missingPatches.length) return { missingPatches };

    const revision = this.transaction(() => {
      this.db.prepare(`
        INSERT INTO features
        (id,tab_id,slot_id,title,subtitle,category,game,image_name,visible,enabled,sort_order,patch_id,antenna_patch_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        feature.id, feature.tabID, feature.slotID, feature.title, feature.subtitle, feature.category, feature.game,
        feature.imageName, bool(feature.visible), bool(feature.enabled), feature.order, feature.patchID,
        feature.withAntennaPatchID, Date.now()
      );
      return this.bumpRevision();
    });
    return { revision };
  }

  updateFeature(featureID, patch) {
    const current = this.getFeature(featureID);
    if (!current) return null;
    const next = {
      tabID: patch.tabID ?? current.tab_id,
      slotID: Object.hasOwn(patch, 'slotID') ? patch.slotID : current.slot_id,
      title: patch.title ?? current.title,
      subtitle: Object.hasOwn(patch, 'subtitle') ? patch.subtitle : current.subtitle,
      category: patch.category ?? current.category,
      game: patch.game ?? current.game,
      imageName: Object.hasOwn(patch, 'imageName') ? patch.imageName : current.image_name,
      visible: patch.visible ?? !!current.visible,
      enabled: patch.enabled ?? !!current.enabled,
      order: patch.order ?? current.sort_order,
      patchID: Object.hasOwn(patch, 'patchID') ? patch.patchID : current.patch_id,
      withAntennaPatchID: Object.hasOwn(patch, 'withAntennaPatchID') ? patch.withAntennaPatchID : current.antenna_patch_id
    };
    if (!this.getTab(next.tabID)) return { missingTab: true };
    const missingPatches = [next.patchID, next.withAntennaPatchID]
      .filter(Boolean)
      .filter(patchID => !this.getPatch(patchID));
    if (missingPatches.length) return { missingPatches };

    const revision = this.transaction(() => {
      this.db.prepare(`
        UPDATE features SET
          tab_id=?,slot_id=?,title=?,subtitle=?,category=?,game=?,image_name=?,visible=?,enabled=?,sort_order=?,patch_id=?,antenna_patch_id=?,updated_at=?
        WHERE id=?
      `).run(
        next.tabID, next.slotID, next.title, next.subtitle, next.category, next.game, next.imageName,
        bool(next.visible), bool(next.enabled), next.order, next.patchID, next.withAntennaPatchID, Date.now(), featureID
      );
      return this.bumpRevision();
    });
    return { revision, feature: { id: featureID, ...next } };
  }

  deleteFeature(featureID) {
    if (!this.getFeature(featureID)) return null;
    const revision = this.transaction(() => {
      this.db.prepare('DELETE FROM features WHERE id=?').run(featureID);
      return this.bumpRevision();
    });
    return { revision };
  }

  createPatch(patch) {
    const now = Date.now();
    const revision = this.transaction(() => {
      this.db.prepare(`
        INSERT INTO patches(id,file_name,password,current_version,sha256,size,storage_path,updated_at)
        VALUES(?,?,?,0,'',0,NULL,?)
      `).run(patch.id, patch.fileName, patch.password, now);
      return this.bumpRevision();
    });
    return { revision };
  }

  updatePatchMetadata(patchID, patch) {
    const current = this.getPatch(patchID);
    if (!current) return null;
    const fileName = patch.fileName ?? current.file_name;
    const password = patch.password ?? current.password;
    const revision = this.transaction(() => {
      this.db.prepare('UPDATE patches SET file_name=?,password=?,updated_at=? WHERE id=?')
        .run(fileName, password, Date.now(), patchID);
      if (current.current_version > 0) {
        this.db.prepare(`UPDATE patch_versions SET file_name=?,password=? WHERE patch_id=? AND version=?`)
          .run(fileName, password, patchID, current.current_version);
      }
      return this.bumpRevision();
    });
    return { revision };
  }

  nextPatchVersion(patchID) {
    return (this.db.prepare('SELECT MAX(version) AS version FROM patch_versions WHERE patch_id=?').get(patchID)?.version ?? 0) + 1;
  }

  publishPatch({ patchID, version, fileName, password, sha256, size, storagePath, note, actor }) {
    const now = Date.now();
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO patch_versions(patch_id,version,file_name,password,sha256,size,storage_path,note,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(patchID, version, fileName, password, sha256, size, storagePath, note || null, now, actor);
      this.db.prepare(`
        UPDATE patches SET file_name=?,password=?,current_version=?,sha256=?,size=?,storage_path=?,updated_at=? WHERE id=?
      `).run(fileName, password, version, sha256, size, storagePath, now, patchID);
      return this.bumpRevision();
    });
  }

  patchVersions(patchID) {
    return this.db.prepare(`
      SELECT version,file_name,password,sha256,size,note,created_at,created_by
      FROM patch_versions WHERE patch_id=? ORDER BY version DESC
    `).all(patchID);
  }

  rollbackPatch(patchID, version) {
    const target = this.db.prepare('SELECT * FROM patch_versions WHERE patch_id=? AND version=?').get(patchID, version);
    if (!target) return null;
    const revision = this.transaction(() => {
      this.db.prepare(`
        UPDATE patches SET file_name=?,password=?,current_version=?,sha256=?,size=?,storage_path=?,updated_at=? WHERE id=?
      `).run(target.file_name, target.password, target.version, target.sha256, target.size, target.storage_path, Date.now(), patchID);
      return this.bumpRevision();
    });
    return { revision, target };
  }

  unpublishPatch(patchID) {
    if (!this.getPatch(patchID)) return null;
    const revision = this.transaction(() => {
      this.db.prepare(`UPDATE patches SET current_version=0,sha256='',size=0,storage_path=NULL,updated_at=? WHERE id=?`)
        .run(Date.now(), patchID);
      return this.bumpRevision();
    });
    return { revision };
  }

  deletePatch(patchID) {
    const patch = this.getPatch(patchID);
    if (!patch) return { missing: true };
    const refs = this.db.prepare(`
      SELECT id FROM features WHERE patch_id=? OR antenna_patch_id=? ORDER BY id
    `).all(patchID, patchID).map(row => row.id);
    if (refs.length) return { conflict: refs };
    const paths = this.db.prepare('SELECT storage_path FROM patch_versions WHERE patch_id=?').all(patchID).map(row => row.storage_path);
    const revision = this.transaction(() => {
      this.db.prepare('DELETE FROM patches WHERE id=?').run(patchID);
      return this.bumpRevision();
    });
    return { revision, paths };
  }

  setPollInterval(seconds) {
    const revision = this.transaction(() => {
      this.setMeta('pollIntervalSeconds', String(seconds));
      return this.bumpRevision();
    });
    return { revision };
  }

  createSession(session) {
    this.cleanupSessions();
    this.db.prepare(`
      INSERT INTO admin_sessions(token_hash,created_at,expires_at,last_seen_at,ip,user_agent)
      VALUES(?,?,?,?,?,?)
    `).run(session.tokenHash, session.createdAt, session.expiresAt, session.lastSeenAt, session.ip, session.userAgent);
  }

  getSession(hash) { return this.db.prepare('SELECT * FROM admin_sessions WHERE token_hash=?').get(hash) || null; }
  touchSession(hash, now) { this.db.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?').run(now, hash); }
  deleteSession(hash) { this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash); }
  cleanupSessions() { this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now()); }

  audit(eventType, actor, ip, details = {}) {
    this.db.prepare(`INSERT INTO audit_log(event_type,actor,ip,details_json,created_at) VALUES(?,?,?,?,?)`)
      .run(eventType, actor, ip, json(details), Date.now());
  }

  auditList(limit = 100) {
    return this.db.prepare(`SELECT id,event_type,actor,ip,details_json,created_at FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit).map(row => ({ ...row, details: JSON.parse(row.details_json), details_json: undefined }));
  }

  relativePatchPath(patchID, version) {
    return path.posix.join('patches', patchID, `v${version}.3105`);
  }

  absoluteStoragePath(relative) {
    const full = path.resolve(this.dataDir, relative);
    const root = path.resolve(this.dataDir) + path.sep;
    if (!full.startsWith(root)) throw new Error('Invalid storage path');
    return full;
  }
}
