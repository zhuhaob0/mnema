/**
 * 数据库：node:sqlite 封装 + 迁移
 *
 * 迁移原则：只前进不回退；每个版本一段 SQL；用 meta.schema_version 记录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 6;

const MIGRATIONS = [
  // v1 → 事件索引（L1）
  `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    at TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_kind TEXT NOT NULL,
    participants TEXT NOT NULL,
    relationship_tier TEXT,
    scene TEXT,
    gist TEXT NOT NULL,
    emotion TEXT,
    salience REAL NOT NULL,
    sensitivity TEXT NOT NULL,
    content_class TEXT NOT NULL,
    tags TEXT,
    pointer TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_access TEXT,
    weight REAL NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_tenant_at ON events(tenant, at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_channel ON events(tenant, channel_id, at DESC);
  `,
  // v2 → 语义事实（L2）+ 关系度 + 会话 + 人格 + 叙事
  `
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    text TEXT NOT NULL,
    participants TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    content_class TEXT NOT NULL,
    first_at TEXT NOT NULL,
    last_confirmed_at TEXT NOT NULL,
    sources TEXT,
    confidence REAL NOT NULL DEFAULT 0.8,
    weight REAL NOT NULL,
    embedding BLOB,
    superseded_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_facts_tenant ON facts(tenant);

  CREATE TABLE IF NOT EXISTS relationships (
    tenant TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    score REAL NOT NULL,
    first_seen TEXT,
    last_interact TEXT,
    signals TEXT,
    history TEXT,
    PRIMARY KEY (tenant, contact_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    tenant TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    participants TEXT NOT NULL,
    last_event_at TEXT,
    PRIMARY KEY (tenant, channel_id)
  );

  CREATE TABLE IF NOT EXISTS persona (
    tenant TEXT PRIMARY KEY,
    markdown TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS narrative (
    tenant TEXT PRIMARY KEY,
    markdown TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v3 → 再巩固版本链
  `
  CREATE TABLE IF NOT EXISTS memory_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(tenant, memory_id);
  `,
  // v4 → 交互流（未门控）。关系度必须从"聊过多少"推，而不是"记住多少"，
  // 否则新联系人永远停在 L0（门控会把内容拦住），形成鸡生蛋。
  `
  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    at TEXT NOT NULL,
    chars INTEGER NOT NULL DEFAULT 0,
    emotion TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(tenant, contact_id, at DESC);
  `,
  // v5 → 披露策略：记忆"关于谁"（subject）+ 性格参数 + 巩固水位
  `
  ALTER TABLE events ADD COLUMN subject TEXT;
  ALTER TABLE facts ADD COLUMN subject TEXT;
  ALTER TABLE persona ADD COLUMN traits TEXT;
  CREATE TABLE IF NOT EXISTS tenant_state (
    tenant TEXT PRIMARY KEY,
    last_consolidated_at TEXT,
    last_narrative_at TEXT
  );
  `,
  // v6 → 事实也要记录来源会话：否则私聊抽象出的事实没有 channel 可比较，
  //      召回时只能靠参与者兜底，会把私密内容泄漏到群聊。
  `
  ALTER TABLE facts ADD COLUMN channel_id TEXT;
  ALTER TABLE facts ADD COLUMN channel_kind TEXT;
  CREATE INDEX IF NOT EXISTS idx_facts_channel ON facts(tenant, channel_id);
  `,
];

function getUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/** 打开数据库并迁移到最新版本（幂等） */
export function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  let version = getUserVersion(db);
  while (version < SCHEMA_VERSION) {
    const sql = MIGRATIONS[version];
    if (!sql) throw new Error(`缺少 v${version + 1} 的迁移脚本`);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return version;
}

export function schemaInfo(db) {
  return { schemaVersion: getUserVersion(db), expected: SCHEMA_VERSION };
}
