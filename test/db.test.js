import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { openDatabase, migrate, SCHEMA_VERSION, schemaInfo } from '../src/db/database.js';
import * as store from '../src/store.js';

test('迁移把空库升到最新版本', () => {
  const db = openDatabase(':memory:');
  const info = schemaInfo(db);
  assert.equal(info.schemaVersion, SCHEMA_VERSION);
  assert.equal(info.expected, SCHEMA_VERSION);
  db.close();
});

test('重复迁移是幂等的', () => {
  const db = openDatabase(':memory:');
  const v1 = migrate(db);
  const v2 = migrate(db);
  assert.equal(v1, SCHEMA_VERSION);
  assert.equal(v2, SCHEMA_VERSION);
  db.close();
});

test('落盘后重开仍是同一版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnema-'));
  const file = path.join(dir, 'test.db');
  let db = openDatabase(file);
  assert.equal(schemaInfo(db).schemaVersion, SCHEMA_VERSION);
  db.close();
  db = openDatabase(file);
  assert.equal(schemaInfo(db).schemaVersion, SCHEMA_VERSION);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事件读写与向量往返', () => {
  const db = openDatabase(':memory:');
  const vec = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  store.insertEvent(db, {
    id: 'ev_1', tenant: 't', at: '2026-10-30T10:00:00Z', channelId: 'chat:1', channelKind: 'direct',
    participants: ['user:1'], gist: '测试事件', salience: 0.8, sensitivity: 'channel',
    contentClass: 'event', tags: ['test'], weight: 0.8, embedding: vec, createdAt: '2026-10-30T10:00:00Z',
  });
  const got = store.getEvent(db, 'ev_1');
  assert.equal(got.gist, '测试事件');
  assert.deepEqual([...got.embedding], [...vec]);
  db.close();
});

test('关系度 upsert 与读取', () => {
  const db = openDatabase(':memory:');
  store.upsertRelationship(db, {
    tenant: 't', contactId: 'user:1', tier: 'L2', score: 0.42,
    firstSeen: '2026-10-01', lastInteract: '2026-10-30', signals: { freq: 0.3 }, history: [],
  });
  const rel = store.getRelationship(db, 't', 'user:1');
  assert.equal(rel.tier, 'L2');
  assert.equal(rel.signals.freq, 0.3);
  db.close();
});
