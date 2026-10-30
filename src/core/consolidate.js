/**
 * 巩固（仿慢波睡眠）
 *
 * 事件 → 聚类 → 抽象成事实 → 与旧事实合并/分离 → 衰减 → 沉底
 *
 * P2 是"规则版"：不调 LLM，靠 embedding 相似度 + 显著度。
 * 将来换 LLM 只替换 extractFactText（同一接口）。
 */

import { cosine } from '../util/misc.js';

/**
 * 按向量相似度聚类（单链：与簇代表相似即入簇）
 */
export function clusterBySimilarity(items, { threshold = 0.85, getVector = (x) => x.embedding } = {}) {
  const clusters = [];
  for (const item of items) {
    const vec = getVector(item);
    if (!vec) continue;
    let placed = false;
    for (const cluster of clusters) {
      const sim = cosine(getVector(cluster[0]), vec);
      if (sim >= threshold) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }
  return clusters;
}

/** 从一簇事件里提炼一句"长期事实"（P2 规则版） */
export function extractFactText(cluster = []) {
  if (cluster.length === 0) return '';
  const sorted = [...cluster].sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  const best = sorted[0];
  const text = String(best.gist ?? best.text ?? '').trim();
  if (!text) return '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** 半衰期衰减（不删除，只降权重） */
export function decayWeight(weight, at, { now = Date.now(), halfLifeDays = 30, floor = 0 } = {}) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return weight;
  const days = Math.max(0, (now - new Date(at).getTime()) / 86400000);
  const decayed = weight * Math.pow(0.5, days / halfLifeDays);
  return Number(Math.max(floor, decayed).toFixed(4));
}

/** 合并判定：相似度分档（模式分离） */
export function mergeDecision(similarity) {
  if (similarity >= 0.92) return 'merge';
  if (similarity >= 0.75) return 'similar';
  return 'new';
}

/** 基础半衰期（天），按内容类别 */
export const HALF_LIFE = {
  topic: 3,
  event: 30,
  fact: 365,
  narrative: 0,
};
