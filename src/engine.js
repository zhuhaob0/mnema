/**
 * 引擎：把编码、门控、存储、关系、检索串起来
 */

import { normalizeConfig } from './config.js';
import { openDatabase, schemaInfo, SCHEMA_VERSION } from './db/database.js';
import * as store from './store.js';
import { EmbeddingProvider } from './core/embedding.js';
import { encodeHeuristic } from './core/encoder.js';
import { gateContent } from './core/gate.js';
import {
  applyDecay, blendScore, deriveSignals, scoreFromSignals, tierFromScore,
} from './core/relationship.js';
import { rankMemories, renderMemories } from './core/recall.js';
import { newId, nowIso } from './util/misc.js';

export function createEngine(options = {}) {
  const config = normalizeConfig(options.config ?? {});
  const clock = options.clock ?? Date.now;
  const db = openDatabase(options.dbPath ?? config.storage.path);
  const embedding = new EmbeddingProvider(config.embedding);

  function selfId() {
    return config.selfId ?? 'self';
  }

  /** 取 channel 里"对方"的关系记录（一对一场景） */
  function relationshipOf(tenant, participants = []) {
    const others = participants.filter((p) => p !== selfId() && !String(p).startsWith('group:'));
    const list = others.map((id) => store.getRelationship(db, tenant, id)).filter(Boolean);
    if (!list.length) return null;
    return list.sort((a, b) => b.score - a.score)[0];
  }

  function tierOf(tenant, participants) {
    const rel = relationshipOf(tenant, participants);
    return rel?.tier ?? 'L0';
  }

  function ensureChannel({ tenant, channel, events, at }) {
    if (!channel?.id) return;
    store.upsertChannel(db, {
      tenant,
      channelId: channel.id,
      kind: channel.kind ?? 'direct',
      participants: channel.participants ?? [],
      lastEventAt: at,
    });
    void events;
  }

  /** 从交互流重算某个联系人的关系度 */
  function refreshRelationship(tenant, contactId, { commit = true } = {}) {
    const interactions = store.listInteractions(db, { tenant, contactId, limit: 2000 });
    const memories = store.countMemoriesForContact(db, tenant, contactId);
    const signals = deriveSignals({ interactions, memories, contactId, now: clock() });
    const rawScore = scoreFromSignals(signals, config.relationship?.weights);
    const existing = store.getRelationship(db, tenant, contactId);
    const decayed = existing
      ? applyDecay({ score: existing.score, lastInteract: existing.lastInteract, now: clock(), cfg: config.relationship })
      : null;
    const score = blendScore(decayed, rawScore, config.relationship?.smoothing ?? 0.7);
    const tier = tierFromScore(score, config.relationship?.thresholds);
    const firstSeen = existing?.firstSeen
      ?? interactions.reduce((acc, i) => (acc === null || i.at < acc ? i.at : acc), null)
      ?? nowIso(clock);
    const lastInteract = interactions.reduce((acc, i) => (acc === null || i.at > acc ? i.at : acc), null)
      ?? existing?.lastInteract
      ?? null;

    const history = [...(existing?.history ?? [])];
    history.push({ at: nowIso(clock), score: Number(score.toFixed(4)) });
    const trimmedHistory = history.slice(-50);

    const rel = {
      tenant, contactId, tier, score: Number(score.toFixed(4)), firstSeen, lastInteract,
      signals, history: trimmedHistory,
    };
    if (commit) store.upsertRelationship(db, rel);
    return rel;
  }

  async function ingest({ tenant = config.tenant, channel, events = [], meta = {} } = {}) {
    const at = nowIso(clock);
    const channelKind = channel?.kind ?? 'direct';
    const participants = channel?.participants ?? [];
    const tier = tierOf(tenant, participants);

    ensureChannel({ tenant, channel, events, at });

    let encoded = 0;
    let skipped = 0;
    const eventIds = [];
    const skipReasons = [];

    for (const raw of events) {
      const text = String(raw?.text ?? '').trim();
      if (!text) {
        skipped += 1;
        skipReasons.push('空文本');
        continue;
      }
      const coded = encodeHeuristic({
        text,
        channelKind,
        tier,
        contactId: participants.find((p) => p !== selfId()) ?? '',
        flags: raw?.flags,
      });

      // 交互流：无论是否被门控/是否值得记，都要计入关系度（否则新联系人永远是 L0）
      for (const p of participants) {
        if (p === selfId() || String(p).startsWith('group:')) continue;
        store.insertInteraction(db, {
          tenant,
          contactId: p,
          channelId: channel?.id ?? 'unknown',
          at: raw?.at ?? at,
          chars: text.length,
          emotion: coded.emotion ?? null,
        });
      }

      if (!coded.worth) {
        skipped += 1;
        skipReasons.push(coded.reason ?? '低显著度');
        continue;
      }

      const gate = gateContent({
        channelKind,
        tier,
        contentClass: coded.contentClass,
        flags: coded.flags ?? {},
        config: config.gate,
      });
      if (!gate.allow) {
        skipped += 1;
        skipReasons.push(gate.reason);
        continue;
      }

      const [vector] = await embedding.embed([`${coded.gist} ${(coded.tags ?? []).join(' ')}`]);
      const ev = {
        id: newId('ev'),
        tenant,
        at: raw?.at ?? at,
        channelId: channel?.id ?? 'unknown',
        channelKind,
        participants,
        relationshipTier: tier,
        scene: coded.scene,
        gist: coded.gist,
        emotion: coded.emotion,
        salience: coded.salience,
        sensitivity: coded.sensitivity,
        contentClass: coded.contentClass,
        tags: coded.tags,
        pointer: `${meta?.pointerPrefix ?? 'archive'}://${String(raw?.at ?? at).slice(0, 10)}/${channel?.id ?? 'unknown'}#${raw?.turnId ?? ''}`,
        weight: coded.salience,
        embedding: vector,
        createdAt: at,
      };
      store.insertEvent(db, ev);
      eventIds.push(ev.id);
      encoded += 1;

      // 长期事实（P1：直接落库；P2 由巩固合并）
      for (const factText of coded.facts ?? []) {
        const [factVector] = await embedding.embed([factText]);
        store.insertFact(db, {
          id: newId('sem'),
          tenant,
          text: factText,
          participants,
          sensitivity: coded.sensitivity,
          contentClass: coded.contentClass,
          firstAt: ev.at,
          lastConfirmedAt: ev.at,
          sources: [ev.id],
          confidence: 0.7,
          weight: 0.75,
          embedding: factVector,
        });
      }
    }

    // 更新涉及联系人的关系度
    for (const p of participants) {
      if (p === selfId() || String(p).startsWith('group:')) continue;
      refreshRelationship(tenant, p);
    }

    return { accepted: events.length, encoded, skipped, eventIds, reasons: skipReasons };
  }

  async function recall({
    tenant = config.tenant, channelId, participants = [], query = '', maxItems, includeNarrative = true,
  } = {}) {
    const cfg = config.recall;
    const events = store.listEvents(db, { tenant, limit: cfg.candidatePool ?? 300 });
    const facts = store.listFacts(db, { tenant, limit: cfg.candidatePool ?? 300 });
    const items = [...events, ...facts];

    let queryVector = null;
    let preferKeyword = false;
    try {
      queryVector = await embedding.embedOne(query);
    } catch {
      preferKeyword = true;
    }
    if (embedding.degraded) preferKeyword = false; // hash 向量仍可算余弦

    const relMap = {};
    for (const c of participants) {
      const rel = store.getRelationship(db, tenant, c);
      if (rel) relMap[c] = rel;
    }

    const scored = rankMemories({
      items, query, queryVector, channelId, participants, relationships: relMap, config: cfg, preferKeyword,
    });

    const narrative = includeNarrative ? store.getNarrative(db, tenant)?.markdown ?? null : null;
    const { items: top, rendered } = renderMemories(scored, { maxItems: maxItems ?? cfg.maxItems, narrative });

    const when = nowIso(clock);
    for (const hit of top) {
      if (hit.kind === 'episodic') store.markEventAccessed(db, hit.id, when);
      else store.markFactAccessed(db, hit.id, when);
    }

    return {
      items: top,
      rendered,
      stats: { candidates: items.length, returned: top.length },
    };
  }

  return {
    config,
    db,
    embedding,
    schema: schemaInfo(db),
    ingest,
    recall,
    refreshRelationship: (contactId, opts) => refreshRelationship(config.tenant, contactId, opts),
    relationships: (tenant = config.tenant) => store.listRelationships(db, tenant),
    relationship: (contactId, tenant = config.tenant) => store.getRelationship(db, tenant, contactId),
    persona: (tenant = config.tenant) => store.getPersona(db, tenant),
    setPersona: (markdown, tenant = config.tenant) => {
      store.setPersona(db, tenant, markdown, nowIso(clock));
      return store.getPersona(db, tenant);
    },
    narrative: (tenant = config.tenant) => store.getNarrative(db, tenant),
    stats: (tenant = config.tenant) => store.stats(db, tenant),
    close: () => db.close(),
    SCHEMA_VERSION,
  };
}
