/**
 * 检索（唤醒）：四路召回 + 融合打分 + 渲染
 */

import { clamp01, cosine, keywordScore, logScale } from '../util/misc.js';

export function sensitivityAllows(item, { channelId, participants }) {
  const set = new Set(participants ?? []);
  const sensitivity = item.sensitivity ?? 'channel';
  if (sensitivity === 'shared') return true;
  if (sensitivity === 'channel') {
    if (item.channelId) return item.channelId === channelId;
    return (item.participants ?? []).some((p) => set.has(p));
  }
  // contact：只在与该联系人相关的 channel
  return (item.participants ?? []).some((p) => set.has(p)) || (item.participants ?? []).length === 0;
}

function relationshipBonus(item, relationships) {
  const list = item.participants ?? [];
  let best = 0;
  for (const p of list) {
    const rel = relationships?.[p];
    if (rel && rel.score > best) best = rel.score;
  }
  return clamp01(best);
}

function similarity(item, queryVector, queryText, preferKeyword) {
  if (!preferKeyword && queryVector && item.embedding) {
    return Math.max(0, cosine(queryVector, item.embedding));
  }
  return keywordScore(queryText, `${item.gist ?? item.text ?? ''} ${(item.tags ?? []).join(' ')}`);
}

/**
 * @param {object} input
 * @param {Array}  input.items          候选（events + facts）
 * @param {string} input.query
 * @param {Float32Array|null} input.queryVector
 * @param {string} input.channelId
 * @param {string[]} input.participants 当前 channel 的参与者
 * @param {object} input.relationships  { contactId: {score, tier} }
 * @param {object} input.config         recall 配置
 * @param {boolean} [input.preferKeyword] 强制关键词检索（降级）
 */
export function rankMemories({
  items, query, queryVector, channelId, participants = [], relationships = {}, config, preferKeyword = false,
}) {
  const weights = config?.weights ?? {
    sim: 0.35, participant: 0.2, freshness: 0.15, relationship: 0.15, salience: 0.1, access: 0.05,
  };
  const set = new Set(participants);

  const scored = [];
  for (const item of items) {
    if (!sensitivityAllows(item, { channelId, participants })) continue;
    const sim = similarity(item, queryVector, query, preferKeyword);
    const participantMatch = (item.participants ?? []).some((p) => set.has(p)) ? 1 : 0;
    const freshness = clamp01(item.weight ?? 0);
    const relationship = relationshipBonus(item, relationships);
    const salience = clamp01(item.salience ?? item.confidence ?? 0.5);
    const access = clamp01(logScale(item.accessCount ?? 0, 20));

    const score = weights.sim * sim
      + weights.participant * participantMatch
      + weights.freshness * freshness
      + weights.relationship * relationship
      + weights.salience * salience
      + weights.access * access;

    scored.push({ item, score: Number(score.toFixed(4)), components: { sim, participantMatch, freshness, relationship, salience, access } });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function renderMemories(scored, { maxItems = 10, narrative = null } = {}) {
  const top = scored.slice(0, maxItems);
  const lines = [];
  if (narrative) {
    lines.push('【你最近的状况】', narrative.trim(), '');
  }
  if (top.length === 0) {
    lines.push('【你记得的】', '- （没有相关的记忆）');
    return { items: [], rendered: lines.join('\n') };
  }
  lines.push('【你记得的】');
  const hints = [];
  const items = [];
  for (const entry of top) {
    const level = entry.disclosure?.level ?? 3;
    if (level <= 0) continue;

    if (level === 1) {
      hints.push(entry);
      items.push({
        id: entry.item.id,
        kind: entry.item.kind ?? (entry.item.text ? 'semantic' : 'episodic'),
        text: entry.item.gist ?? entry.item.text ?? '',
        score: entry.score,
        at: entry.item.at ?? entry.item.firstAt ?? null,
        sensitivity: entry.item.sensitivity,
        disclosure: entry.disclosure,
        withheld: true,
        components: entry.components,
      });
      continue;
    }

    const text = entry.item.gist ?? entry.item.text ?? '';
    const at = entry.item.at ?? entry.item.firstAt ?? '';
    const when = at ? `（${String(at).slice(0, 10)}）` : '';
    const summaryMark = level === 2 ? '（只能概括，不要复述原话）' : '';
    lines.push(`- ${text}${when}${summaryMark}`);
    items.push({
      id: entry.item.id,
      kind: entry.item.kind ?? (entry.item.text ? 'semantic' : 'episodic'),
      text,
      score: entry.score,
      at: entry.item.at ?? entry.item.firstAt ?? null,
      sensitivity: entry.item.sensitivity,
      disclosure: entry.disclosure,
      components: entry.components,
    });
  }

  if (hints.length > 0) {
    lines.push('', '【你知道但不宜细说的】', '- 有些关于某人的事你记得，但只承认"知道"，不要展开内容与被问者的细节');
  }

  return { items, rendered: lines.join('\n') };
}
