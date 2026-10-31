/**
 * 关系度：六信号 → 0~1 分数 → 等级
 *
 * 分由代码算，适配器/模型只提供原始信号，避免"自我膨胀"。
 */

import { clamp01, daysBetween, logScale } from '../util/misc.js';

export const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4'];

/** 从交互流推导原始信号（交互流未门控，因此新联系人也能长） */
export function deriveSignals({ interactions = [], events = null, memories = 0, contactId, now = Date.now() }) {
  // 兼容旧调用：直接传 events 时按 participants 过滤并折算
  const acts = Array.isArray(interactions) && interactions.length > 0
    ? interactions
    : (events ?? [])
      .filter((e) => (e.participants ?? []).includes(contactId))
      .map((e) => ({ at: e.at, chars: String(e.gist ?? '').length, emotion: e.emotion }));

  const count30 = acts.filter((a) => daysBetween(a.at, now) <= 30).length;
  const freq = logScale(count30, 200);

  const firstAt = acts.reduce((acc, a) => (acc === null || a.at < acc ? a.at : acc), null);
  const spanDays = firstAt ? daysBetween(firstAt, now) : 0;
  const span = logScale(spanDays, 365);

  const avgLen = acts.length
    ? acts.reduce((sum, a) => sum + Number(a.chars ?? 0), 0) / acts.length
    : 0;
  const depth = clamp01(logScale(avgLen, 80) * 0.7 + logScale(acts.length, 100) * 0.3);

  const emotionHits = acts.filter((a) => a.emotion && a.emotion !== 'neutral').length;
  const emotion = acts.length ? clamp01(emotionHits / acts.length) : 0;

  // 双向性：需要适配器上报；默认 0.5（未知）
  const mutual = typeof deriveSignals.mutualHint === 'number' ? deriveSignals.mutualHint : 0.5;

  const memoryCount = typeof memories === 'number' && memories > 0 ? memories : acts.length;
  const memoriesSignal = logScale(memoryCount, 100);
  return { freq, span, depth, emotion, mutual, memories: memoriesSignal, eventCount: acts.length };
}

export function scoreFromSignals(signals, weights) {
  const w = weights ?? { freq: 0.25, span: 0.15, depth: 0.2, emotion: 0.15, mutual: 0.15, memories: 0.1 };
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for (const [key, weight] of Object.entries(w)) {
    sum += (Number(signals?.[key]) || 0) * weight;
  }
  return clamp01(sum / total);
}

/** 滑动平均：避免一次长谈暴涨 */
export function blendScore(previous, signal, smoothing = 0.7) {
  if (previous === null || previous === undefined) return clamp01(signal);
  return clamp01(smoothing * previous + (1 - smoothing) * signal);
}

export function tierFromScore(score, thresholds = { L1: 0.15, L2: 0.35, L3: 0.6, L4: 0.8 }) {
  const s = clamp01(score);
  if (s >= thresholds.L4) return 'L4';
  if (s >= thresholds.L3) return 'L3';
  if (s >= thresholds.L2) return 'L2';
  if (s >= thresholds.L1) return 'L1';
  return 'L0';
}

/** 长期无互动降温：每周 × decayPerWeek，带下限 */
export function applyDecay({ score, lastInteract, now = Date.now(), cfg }) {
  const { decayAfterDays = 30, decayPerWeek = 0.9, floor = 0.05 } = cfg ?? {};
  if (!lastInteract) return clamp01(score);
  const idleDays = daysBetween(lastInteract, now);
  if (idleDays <= decayAfterDays) return clamp01(score);
  const weeks = (idleDays - decayAfterDays) / 7;
  const decayed = score * Math.pow(decayPerWeek, weeks);
  return clamp01(Math.max(floor, decayed));
}

export const TIER_RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * 等级封顶：关系要"走到私聊里"才算更近。
 *
 * - 只有群聊互动（没加好友）→ 最多 L2
 * - 有私聊（好友）→ L2 起算，私聊达到阈值后放行 L3 / L4
 *
 * 依据：群聊是公共场合，热络不等于亲近；真正的亲近由一对一交流累积。
 */
export function capTierByPrivate(tier, { hasPrivate = false, privateCount = 0, cfg = {} } = {}) {
  const l3 = Number(cfg.privateForL3 ?? 3);
  const l4 = Number(cfg.privateForL4 ?? 12);
  let maxTier = 'L2';
  if (hasPrivate) {
    maxTier = privateCount >= l4 ? 'L4' : privateCount >= l3 ? 'L3' : 'L2';
  }
  return TIER_RANK[tier] > TIER_RANK[maxTier] ? maxTier : tier;
}

export function atLeastTier(tier, minimum) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[minimum] ?? 0);
}
