/**
 * 存储层：SQLite 读写（所有 SQL 只在这里出现）
 */

import { bufferToVector, vectorToBuffer } from './util/misc.js';

const parseJson = (v, fallback) => {
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const toJson = (v) => JSON.stringify(v ?? null);

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant: row.tenant,
    at: row.at,
    channelId: row.channel_id,
    channelKind: row.channel_kind,
    participants: parseJson(row.participants, []),
    subject: parseJson(row.subject, []),
    relationshipTier: row.relationship_tier,
    scene: row.scene,
    gist: row.gist,
    emotion: row.emotion,
    salience: row.salience,
    sensitivity: row.sensitivity,
    contentClass: row.content_class,
    tags: parseJson(row.tags, []),
    pointer: row.pointer,
    accessCount: row.access_count,
    lastAccess: row.last_access,
    weight: row.weight,
    embedding: bufferToVector(row.embedding),
    createdAt: row.created_at,
    channelId: row.channel_id ?? null,
    channelKind: row.channel_kind ?? null,
  };
}

function rowToFact(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant: row.tenant,
    text: row.text,
    participants: parseJson(row.participants, []),
    subject: parseJson(row.subject, []),
    sensitivity: row.sensitivity,
    contentClass: row.content_class,
    firstAt: row.first_at,
    lastConfirmedAt: row.last_confirmed_at,
    sources: parseJson(row.sources, []),
    confidence: row.confidence,
    weight: row.weight,
    supersededBy: row.superseded_by,
    embedding: bufferToVector(row.embedding),
    createdAt: row.created_at,
    channelId: row.channel_id ?? null,
    channelKind: row.channel_kind ?? null,
  };
}

// ── events ────────────────────────────────────────────────
export function insertEvent(db, ev) {
  db.prepare(`INSERT INTO events (
      id, tenant, at, channel_id, channel_kind, participants, subject, relationship_tier,
      scene, gist, emotion, salience, sensitivity, content_class, tags, pointer,
      access_count, last_access, weight, embedding, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ev.id, ev.tenant, ev.at, ev.channelId, ev.channelKind, toJson(ev.participants),
    toJson(ev.subject ?? ev.participants ?? []),
    ev.relationshipTier ?? null, ev.scene ?? null, ev.gist ?? '', ev.emotion ?? null,
    ev.salience ?? 0, ev.sensitivity ?? 'channel', ev.contentClass ?? 'event',
    toJson(ev.tags ?? []), ev.pointer ?? null, 0, null,
    ev.weight ?? ev.salience ?? 0, vectorToBuffer(ev.embedding), ev.createdAt ?? ev.at,
  );
  return ev.id;
}

export function getEvent(db, id) {
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
}

export function listEvents(db, { tenant, channelId, since, limit = 200 } = {}) {
  const clauses = ['tenant = ?'];
  const params = [tenant];
  if (channelId) {
    clauses.push('channel_id = ?');
    params.push(channelId);
  }
  if (since) {
    clauses.push('at >= ?');
    params.push(since);
  }
  params.push(limit);
  const rows = db
    .prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY at DESC LIMIT ?`)
    .all(...params);
  return rows.map(rowToEvent);
}

export function markEventAccessed(db, id, when) {
  db.prepare('UPDATE events SET access_count = access_count + 1, last_access = ? WHERE id = ?').run(when, id);
}

export function updateEventWeight(db, id, weight) {
  db.prepare('UPDATE events SET weight = ? WHERE id = ?').run(weight, id);
}

// ── facts ─────────────────────────────────────────────────
export function insertFact(db, fact) {
  db.prepare(`INSERT INTO facts (
      id, tenant, text, participants, subject, sensitivity, content_class, first_at,
      last_confirmed_at, sources, confidence, weight, embedding, superseded_by, created_at,
      channel_id, channel_kind
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fact.id, fact.tenant, fact.text, toJson(fact.participants),
    toJson(fact.subject ?? fact.participants ?? []),
    fact.sensitivity, fact.contentClass ?? 'event', fact.firstAt,
    fact.lastConfirmedAt ?? fact.firstAt, toJson(fact.sources ?? []),
    fact.confidence ?? 0.8, fact.weight ?? 0.8,
    vectorToBuffer(fact.embedding), fact.supersededBy ?? null, fact.createdAt ?? fact.firstAt,
    fact.channelId ?? null, fact.channelKind ?? null,
  );
  return fact.id;
}

export function listFacts(db, { tenant, limit = 500 } = {}) {
  return db
    .prepare('SELECT * FROM facts WHERE tenant = ? ORDER BY last_confirmed_at DESC LIMIT ?')
    .all(tenant, limit)
    .map(rowToFact);
}

export function getFact(db, id) {
  return rowToFact(db.prepare('SELECT * FROM facts WHERE id = ?').get(id));
}

export function updateFact(db, id, patch = {}) {
  const current = getFact(db, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`UPDATE facts SET text = ?, last_confirmed_at = ?, sources = ?, weight = ?,
      confidence = ?, embedding = ?, superseded_by = ? WHERE id = ?`).run(
    next.text, next.lastConfirmedAt, toJson(next.sources ?? []), next.weight,
    next.confidence ?? 0.8, vectorToBuffer(next.embedding), next.supersededBy ?? null, id,
  );
  return getFact(db, id);
}

export function deleteFact(db, id) {
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

export function markFactAccessed(db, id) {
  db.prepare('UPDATE facts SET weight = MIN(1, weight + 0.02) WHERE id = ?').run(id);
}

// ── relationships ─────────────────────────────────────────
export function getRelationship(db, tenant, contactId) {
  const row = db
    .prepare('SELECT * FROM relationships WHERE tenant = ? AND contact_id = ?')
    .get(tenant, contactId);
  if (!row) return null;
  return {
    tenant: row.tenant,
    contactId: row.contact_id,
    tier: row.tier,
    score: row.score,
    firstSeen: row.first_seen,
    lastInteract: row.last_interact,
    signals: parseJson(row.signals, {}),
    history: parseJson(row.history, []),
  };
}

export function listRelationships(db, tenant) {
  return db
    .prepare('SELECT * FROM relationships WHERE tenant = ? ORDER BY score DESC')
    .all(tenant)
    .map((row) => getRelationship(db, row.tenant, row.contact_id));
}

export function upsertRelationship(db, rel) {
  db.prepare(`INSERT INTO relationships (tenant, contact_id, tier, score, first_seen, last_interact, signals, history)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant, contact_id) DO UPDATE SET
      tier = excluded.tier, score = excluded.score, first_seen = excluded.first_seen,
      last_interact = excluded.last_interact, signals = excluded.signals, history = excluded.history`).run(
    rel.tenant, rel.contactId, rel.tier, rel.score, rel.firstSeen ?? null,
    rel.lastInteract ?? null, toJson(rel.signals ?? {}), toJson(rel.history ?? []),
  );
  return rel;
}

// ── channels ──────────────────────────────────────────────
export function upsertChannel(db, { tenant, channelId, kind, participants, lastEventAt }) {
  db.prepare(`INSERT INTO channels (tenant, channel_id, kind, participants, last_event_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(tenant, channel_id) DO UPDATE SET
      kind = excluded.kind, participants = excluded.participants,
      last_event_at = COALESCE(excluded.last_event_at, channels.last_event_at)`).run(
    tenant, channelId, kind, toJson(participants), lastEventAt ?? null,
  );
}

export function getChannel(db, tenant, channelId) {
  const row = db
    .prepare('SELECT * FROM channels WHERE tenant = ? AND channel_id = ?')
    .get(tenant, channelId);
  if (!row) return null;
  return {
    tenant: row.tenant,
    channelId: row.channel_id,
    kind: row.kind,
    participants: parseJson(row.participants, []),
    lastEventAt: row.last_event_at,
  };
}

// ── persona / narrative ───────────────────────────────────
export function getPersona(db, tenant) {
  const row = db.prepare('SELECT * FROM persona WHERE tenant = ?').get(tenant);
  return row
    ? { markdown: row.markdown, traits: parseJson(row.traits, {}), updatedAt: row.updated_at }
    : null;
}

export function setPersona(db, tenant, markdown, when, traits = {}) {
  db.prepare(`INSERT INTO persona (tenant, markdown, traits, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(tenant) DO UPDATE SET markdown = excluded.markdown,
      traits = excluded.traits, updated_at = excluded.updated_at`)
    .run(tenant, markdown, toJson(traits), when);
}

export function getNarrative(db, tenant) {
  const row = db.prepare('SELECT * FROM narrative WHERE tenant = ?').get(tenant);
  return row ? { markdown: row.markdown, updatedAt: row.updated_at } : null;
}

export function setNarrative(db, tenant, markdown, when) {
  db.prepare(`INSERT INTO narrative (tenant, markdown, updated_at) VALUES (?,?,?)
    ON CONFLICT(tenant) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`)
    .run(tenant, markdown, when);
}

// ── tenant state（巩固水位） ──────────────────────────────
export function getTenantState(db, tenant) {
  const row = db.prepare('SELECT * FROM tenant_state WHERE tenant = ?').get(tenant);
  return {
    lastConsolidatedAt: row?.last_consolidated_at ?? null,
    lastNarrativeAt: row?.last_narrative_at ?? null,
  };
}

export function setTenantState(db, tenant, patch = {}) {
  const current = getTenantState(db, tenant);
  const next = { ...current, ...patch };
  db.prepare(`INSERT INTO tenant_state (tenant, last_consolidated_at, last_narrative_at)
    VALUES (?,?,?)
    ON CONFLICT(tenant) DO UPDATE SET
      last_consolidated_at = excluded.last_consolidated_at,
      last_narrative_at = excluded.last_narrative_at`)
    .run(tenant, next.lastConsolidatedAt ?? null, next.lastNarrativeAt ?? null);
  return next;
}

// ── versions ──────────────────────────────────────────────
export function addVersion(db, { tenant, memoryId, kind, text, at }) {
  db.prepare('INSERT INTO memory_versions (tenant, memory_id, kind, text, at) VALUES (?,?,?,?,?)')
    .run(tenant, memoryId, kind, text, at);
}

export function listVersions(db, tenant, memoryId) {
  return db
    .prepare('SELECT * FROM memory_versions WHERE tenant = ? AND memory_id = ? ORDER BY at DESC')
    .all(tenant, memoryId);
}

// ── interactions（未门控的交互流，关系度用） ─────────────
export function insertInteraction(db, { tenant, contactId, channelId, at, chars = 0, emotion = null }) {
  db.prepare('INSERT INTO interactions (tenant, contact_id, channel_id, at, chars, emotion) VALUES (?,?,?,?,?,?)')
    .run(tenant, contactId, channelId, at, chars, emotion);
}

export function listInteractions(db, { tenant, contactId, limit = 2000 } = {}) {
  return db
    .prepare('SELECT * FROM interactions WHERE tenant = ? AND contact_id = ? ORDER BY at DESC LIMIT ?')
    .all(tenant, contactId, limit)
    .map((row) => ({ contactId: row.contact_id, channelId: row.channel_id, at: row.at, chars: row.chars, emotion: row.emotion }));
}

export function countMemoriesForContact(db, tenant, contactId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE tenant = ? AND participants LIKE ?')
    .get(tenant, `%"${contactId}"%`);
  return Number(row?.n ?? 0);
}

// ── stats ─────────────────────────────────────────────────
export function stats(db, tenant) {
  const one = (sql) => db.prepare(sql).get(tenant)?.n ?? 0;
  return {
    events: one('SELECT COUNT(*) AS n FROM events WHERE tenant = ?'),
    facts: one('SELECT COUNT(*) AS n FROM facts WHERE tenant = ?'),
    relationships: one('SELECT COUNT(*) AS n FROM relationships WHERE tenant = ?'),
    channels: one('SELECT COUNT(*) AS n FROM channels WHERE tenant = ?'),
    versions: one('SELECT COUNT(*) AS n FROM memory_versions WHERE tenant = ?'),
    interactions: one('SELECT COUNT(*) AS n FROM interactions WHERE tenant = ?'),
  };
}

export function updateFactWeight(db, id, weight) {
  db.prepare('UPDATE facts SET weight = ? WHERE id = ?').run(weight, id);
}

export function listEventsSince(db, { tenant, since, limit = 500 } = {}) {
  if (!since) return listEvents(db, { tenant, limit });
  return db
    .prepare('SELECT * FROM events WHERE tenant = ? AND at > ? ORDER BY at ASC LIMIT ?')
    .all(tenant, since, limit)
    .map((row) => ({
      id: row.id, tenant: row.tenant, at: row.at, channelId: row.channel_id,
      channelKind: row.channel_kind, participants: parseJson(row.participants, []),
      subject: parseJson(row.subject, []), relationshipTier: row.relationship_tier,
      scene: row.scene, gist: row.gist, emotion: row.emotion, salience: row.salience,
      sensitivity: row.sensitivity, contentClass: row.content_class,
      tags: parseJson(row.tags, []), pointer: row.pointer, accessCount: row.access_count,
      lastAccess: row.last_access, weight: row.weight,
      embedding: bufferToVector(row.embedding), createdAt: row.created_at,
    }));
}

export function updateEventGist(db, id, gist, weight) {
  db.prepare('UPDATE events SET gist = ?, weight = COALESCE(?, weight) WHERE id = ?').run(gist, weight ?? null, id);
}

export function deleteEvent(db, id) {
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

export function listMemories(db, { tenant, kind = 'all', limit = 100, offset = 0 } = {}) {
  const rows = [];
  if (kind === 'all' || kind === 'episodic' || kind === 'event') {
    const events = db
      .prepare('SELECT * FROM events WHERE tenant = ? ORDER BY at DESC LIMIT ? OFFSET ?')
      .all(tenant, limit, offset);
    rows.push(...events.map((r) => ({ ...rowToEvent(r), kind: 'episodic' })));
  }
  if (kind === 'all' || kind === 'semantic' || kind === 'fact') {
    const facts = db
      .prepare('SELECT * FROM facts WHERE tenant = ? ORDER BY last_confirmed_at DESC LIMIT ? OFFSET ?')
      .all(tenant, limit, offset);
    rows.push(...facts.map((r) => ({ ...rowToFact(r), kind: 'semantic' })));
  }
  return rows
    .sort((a, b) => new Date(b.at ?? b.lastConfirmedAt ?? 0) - new Date(a.at ?? a.lastConfirmedAt ?? 0))
    .slice(0, limit);
}