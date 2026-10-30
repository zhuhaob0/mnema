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
import { computeDisclosure } from './core/disclosure.js';
import { clusterBySimilarity, decayWeight, extractFactText, HALF_LIFE, mergeDecision } from './core/consolidate.js';
import { generateNarrative } from './core/narrative.js';
import { cosine } from './util/misc.js';
import { newId, nowIso } from './util/misc.js';

const logSafe = (msg) => { try { console.error(String(msg)); } catch { /* 忽略 */ } };

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
        role: raw?.role ?? 'user',
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
        subject: coded.subject ?? participants,
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
          subject: coded.subject ?? participants,
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
    const floor = Number(config.decay?.floor ?? 0.15);
    // 沉底（weight 低于阈值）不参与常规检索
    const items = [...events, ...facts].filter((i) => (i.weight ?? 1) >= floor);

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

    // 披露：记得 ≠ 该说。按听众/主体/性格算出每条能说多少
    const traits = store.getPersona(db, tenant)?.traits ?? {};
    const annotated = scored.map((entry) => ({
      ...entry,
      disclosure: computeDisclosure({
        memory: entry.item,
        audience: participants,
        relationships: relMap,
        traits,
        config: config.disclosure,
      }),
    }));

    const narrative = includeNarrative ? store.getNarrative(db, tenant)?.markdown ?? null : null;
    const { items: top, rendered } = renderMemories(annotated, { maxItems: maxItems ?? cfg.maxItems, narrative });

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

  /**
   * 巩固（仿慢波睡眠）：事件聚类 → 抽象事实 → 合并/分离 → 衰减 → 关系重算
   * @param {{tenant?: string, now?: number}} [options]
   */
  async function consolidate({ tenant = config.tenant, now = clock() } = {}) {
    const floor = Number(config.decay?.floor ?? 0.15);
    const state = store.getTenantState(db, tenant);
    const pending = store.listEventsSince(db, { tenant, since: state.lastConsolidatedAt, limit: 500 });
    const facts = store.listFacts(db, { tenant, limit: 1000 });

    const clusters = clusterBySimilarity(
      pending.filter((e) => (e.weight ?? 0) >= floor && e.embedding),
      { threshold: 0.85 },
    );

    let factsCreated = 0;
    let factsMerged = 0;
    let factsSimilar = 0;

    for (const cluster of clusters) {
      if (cluster.length < 2) continue; // 单条事件不抽象，避免事实库膨胀
      const text = extractFactText(cluster);
      if (!text) continue;
      const [vec] = await embedding.embed([text]);

      let best = null;
      let bestSim = 0;
      for (const fact of facts) {
        const sim = cosine(vec, fact.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          best = fact;
        }
      }

      const decision = best ? mergeDecision(bestSim) : 'new';
      if (decision === 'merge') {
        const times = cluster.map((e) => e.at).sort();
        store.updateFact(db, best.id, {
          lastConfirmedAt: times[times.length - 1],
          sources: [...new Set([...(best.sources ?? []), ...cluster.map((e) => e.id)])],
          weight: Math.min(1, Number(best.weight ?? 0.8) + 0.05),
        });
        factsMerged += 1;
      } else if (decision === 'new') {
        const times = cluster.map((e) => e.at).sort();
        const fact = {
          id: newId('sem'),
          tenant,
          text,
          participants: cluster[0].participants ?? [],
          subject: cluster[0].subject ?? [],
          sensitivity: cluster[0].sensitivity ?? 'channel',
          contentClass: cluster[0].contentClass ?? 'event',
          firstAt: times[0],
          lastConfirmedAt: times[times.length - 1],
          sources: cluster.map((e) => e.id),
          confidence: 0.75,
          weight: 0.8,
          embedding: vec,
        };
        store.insertFact(db, fact);
        facts.push(fact);
        factsCreated += 1;
      } else {
        factsSimilar += 1; // 相似但不同 → 并存（模式分离）
      }
    }

    // 衰减：事件按 30 天半衰期，事实按 365 天
    let decayed = 0;
    for (const ev of pending) {
      const next = decayWeight(ev.weight ?? 0.5, ev.at, { now, halfLifeDays: HALF_LIFE.event });
      if (Math.abs(next - Number(ev.weight ?? 0)) > 0.001) {
        store.updateEventWeight(db, ev.id, next);
        decayed += 1;
      }
    }
    for (const fact of facts) {
      const next = decayWeight(fact.weight ?? 0.8, fact.lastConfirmedAt ?? fact.firstAt, { now, halfLifeDays: HALF_LIFE.fact });
      if (Math.abs(next - Number(fact.weight ?? 0)) > 0.001) {
        store.updateFactWeight(db, fact.id, next);
        decayed += 1;
      }
    }

    // 关系重算（本批涉及到的联系人）
    const contacts = new Set();
    for (const ev of pending) {
      for (const p of ev.participants ?? []) {
        if (p !== selfId() && !String(p).startsWith('group:')) contacts.add(p);
      }
    }
    for (const c of contacts) refreshRelationship(tenant, c);

    const finishedAt = new Date(now).toISOString();
    store.setTenantState(db, tenant, { lastConsolidatedAt: finishedAt });

    // 叙事自我：像睡醒后整理"我最近过得怎么样"
    let narrativeUpdated = false;
    if (config.narrative?.enabled !== false) {
      try {
        const allEvents = store.listEvents(db, { tenant, limit: config.narrative?.maxEvents ?? 40 });
        const allFacts = store.listFacts(db, { tenant, limit: 200 });
        const rels = store.listRelationships(db, tenant);
        const persona = store.getPersona(db, tenant)?.markdown ?? '';
        const markdown = generateNarrative({
          events: allEvents,
          facts: allFacts,
          relationships: rels,
          persona,
          now,
          maxEvents: config.narrative?.maxEvents ?? 40,
          maxContacts: config.narrative?.maxContacts ?? 5,
        });
        store.setNarrative(db, tenant, markdown, finishedAt);
        store.setTenantState(db, tenant, { lastNarrativeAt: finishedAt });
        narrativeUpdated = true;
      } catch (error) {
        logSafe(`[narrative] 生成失败：${error?.message ?? error}`);
      }
    }

    return {
      ok: true,
      tenant,
      scanned: pending.length,
      clusters: clusters.length,
      factsCreated,
      factsMerged,
      factsSimilar,
      decayed,
      narrativeUpdated,
      finishedAt,
    };
  }

  /** 单独重写叙事（调试/手动） */
  function regenerateNarrative({ tenant = config.tenant, now = clock() } = {}) {
    const markdown = generateNarrative({
      events: store.listEvents(db, { tenant, limit: config.narrative?.maxEvents ?? 40 }),
      facts: store.listFacts(db, { tenant, limit: 200 }),
      relationships: store.listRelationships(db, tenant),
      persona: store.getPersona(db, tenant)?.markdown ?? '',
      now,
      maxEvents: config.narrative?.maxEvents ?? 40,
      maxContacts: config.narrative?.maxContacts ?? 5,
    });
    const at = new Date(now).toISOString();
    store.setNarrative(db, tenant, markdown, at);
    store.setTenantState(db, tenant, { lastNarrativeAt: at });
    return { markdown, updatedAt: at };
  }

  return {
    config,
    db,
    embedding,
    schema: schemaInfo(db),
    ingest,
    recall,
    consolidate,
    regenerateNarrative,
    refreshRelationship: (contactId, opts) => refreshRelationship(config.tenant, contactId, opts),
    relationships: (tenant = config.tenant) => store.listRelationships(db, tenant),
    relationship: (contactId, tenant = config.tenant) => store.getRelationship(db, tenant, contactId),
    persona: (tenant = config.tenant) => store.getPersona(db, tenant),
    setPersona: (markdown, tenant = config.tenant, traits = null) => {
      const merged = { ...(config.personaTraits ?? {}), ...(traits ?? {}) };
      store.setPersona(db, tenant, markdown, nowIso(clock), merged);
      return store.getPersona(db, tenant);
    },
    narrative: (tenant = config.tenant) => store.getNarrative(db, tenant),
    disclosureFor: (memory, audience = [], tenant = config.tenant) => {
      const relMap = {};
      for (const c of audience) {
        const rel = store.getRelationship(db, tenant, c);
        if (rel) relMap[c] = rel;
      }
      return computeDisclosure({
        memory, audience, relationships: relMap,
        traits: store.getPersona(db, tenant)?.traits ?? {},
        config: config.disclosure,
      });
    },
    stats: (tenant = config.tenant) => store.stats(db, tenant),

    /** 浏览记忆（控制台/调试用） */
    memories: ({ tenant = config.tenant, kind = 'all', limit = 100, offset = 0 } = {}) => (
      store.listMemories(db, { tenant, kind, limit, offset })
    ),

    /**
     * 再巩固：纠正 / 确认 / 遗忘
     * - correct：写新版本，旧版本进版本链（记忆改写）
     * - confirm：确认仍然成立，权重上调
     * - forget：真删（隐私要求"请忘掉这件事"）
     */
    feedback({ tenant = config.tenant, op, memoryId, text = '' } = {}) {
      if (!memoryId) return { ok: false, error: 'memoryId 不能为空' };
      if (!['correct', 'confirm', 'forget'].includes(op)) {
        return { ok: false, error: 'op 必须是 correct / confirm / forget' };
      }
      const at = nowIso(clock);
      const event = store.getEvent(db, memoryId);
      const fact = event ? null : store.getFact(db, memoryId);
      if (!event && !fact) return { ok: false, error: '未找到该记忆' };

      const kind = event ? 'episodic' : 'semantic';
      const oldText = event ? (event.gist ?? '') : (fact.text ?? '');

      if (op === 'confirm') {
        if (fact) {
          store.updateFact(db, fact.id, {
            lastConfirmedAt: at,
            weight: Math.min(1, Number(fact.weight ?? 0.8) + 0.05),
          });
        } else {
          store.updateEventWeight(db, event.id, Math.min(1, Number(event.weight ?? 0.5) + 0.05));
        }
        return { ok: true, op, memoryId, kind, text: oldText };
      }

      if (op === 'correct') {
        const next = String(text ?? '').trim();
        if (!next) return { ok: false, error: 'correct 需要 text' };
        store.addVersion(db, { tenant, memoryId, kind, text: oldText, at });
        if (fact) {
          store.updateFact(db, fact.id, {
            text: next,
            lastConfirmedAt: at,
            weight: Math.min(1, Number(fact.weight ?? 0.8) + 0.05),
            sources: [...new Set([...(fact.sources ?? []), `correction:${at}`])],
          });
        } else {
          store.updateEventGist(db, event.id, next, Math.min(1, Number(event.weight ?? 0.5) + 0.05));
        }
        return { ok: true, op, memoryId, kind, from: oldText, to: next };
      }

      // forget：真删
      store.addVersion(db, { tenant, memoryId, kind, text: oldText, at });
      if (fact) store.deleteFact(db, fact.id);
      else store.deleteEvent(db, event.id);
      return { ok: true, op, memoryId, kind, forgotten: oldText };
    },

    versions: (memoryId, tenant = config.tenant) => store.listVersions(db, tenant, memoryId),
    close: () => db.close(),
    SCHEMA_VERSION,
  };
}
