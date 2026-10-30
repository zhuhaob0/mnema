/**
 * 披露策略：记得 ≠ 该说
 *
 * 检索回答"我知道什么"，披露回答"我该说多少"。
 * 四个变量共同决定：听众与我的关系、主体与我的关系、内容敏感度、我的性格。
 *
 * 等级：
 *   3 = 可以说细节
 *   2 = 只能说概括
 *   1 = 只承认"我知道"，不便展开
 *   0 = 不说
 */

import { clamp01 } from '../util/misc.js';

export const LEVELS = { FULL: 3, SUMMARY: 2, HINT: 1, SILENT: 0 };

const SENSITIVITY_RANK = { secret: 3, feeling: 2, status: 1, preference: 1, event: 0, commitment: 1 };

function maxRelationship(ids = [], relationships = {}) {
  let best = 0;
  for (const id of ids) {
    const rel = relationships?.[id];
    if (rel && rel.score > best) best = rel.score;
  }
  return best;
}

/**
 * @param {object} input
 * @param {object} input.memory          记忆条目（需含 subject/participants/sensitivity/contentClass）
 * @param {string[]} input.audience     当前 channel 的参与者
 * @param {object} input.relationships  { contactId: {score, tier} }
 * @param {object} [input.traits]       性格参数 { discretion, gossip, protectiveness } 0~1
 * @param {object} [input.config]       覆盖默认阈值
 * @returns {{ level: number, reason: string, subjectPresent: boolean }}
 */
export function computeDisclosure({ memory, audience = [], relationships = {}, traits = {}, config = {} }) {
  const subject = memory?.subject ?? memory?.participants ?? [];
  const audienceSet = new Set(audience);
  const subjectPresent = subject.some((s) => audienceSet.has(s));

  const discretion = clamp01(traits?.discretion ?? 0.5);
  const gossip = clamp01(traits?.gossip ?? 0.3);
  const protectiveness = clamp01(traits?.protectiveness ?? 0.5);
  const sensitivity = memory?.sensitivity ?? 'channel';
  const contentClass = memory?.contentClass ?? 'event';
  const sensitivityRank = SENSITIVITY_RANK[contentClass] ?? 0;

  // ① 主体就在场（就是问的人，或当时一起在场）→ 不构成新泄露
  if (subjectPresent) {
    const base = contentClass === 'secret' ? 2 : 3;
    const capped = Math.max(Number(config.minLevel ?? 0), Math.min(Number(config.maxLevel ?? 3), base));
    return { level: capped, reason: '主体在场，属于共同经历', subjectPresent };
  }

  // ② 主体不在场：基线保守
  let level = 1;
  let reason = '主体不在场，只承认知道';

  if (sensitivity === 'shared') {
    level = 2;
    reason = '主人标记为可跨会话共享，只能概括';
  } else if (sensitivity === 'contact') {
    level = 2;
    reason = '与该联系人相关，可说概括';
  }

  // ③ 敏感度上限
  if (contentClass === 'secret') {
    level = Math.min(level, 1);
    reason = '第三方私事，最多承认知道';
  } else if (contentClass === 'feeling') {
    level = Math.min(level, 2);
    reason = '第三方情绪，最多概括';
  }

  // ④ 关系调制
  const audienceRel = maxRelationship(audience.filter((a) => a !== 'self'), relationships);
  const subjectRel = maxRelationship(subject, relationships);

  if (subjectRel > audienceRel + 0.2) {
    level = Math.min(level, 1);
    reason = '与主体更亲近，倾向保护他';
  } else if (audienceRel >= 0.7 && sensitivityRank <= 1) {
    level = Math.min(3, level + 1);
    reason = '与听众很熟，且内容不敏感，可多说一点';
  }

  // ⑤ 性格调制
  if (discretion >= 0.65) {
    level = Math.max(0, level - 1);
    reason = '性格谨慎，压低披露';
  } else if (gossip >= 0.65 && contentClass !== 'secret') {
    level = Math.min(3, level + 1);
    reason = '性格爱聊，愿意多说';
  }
  if (protectiveness >= 0.7 && subject.length > 0) {
    level = Math.max(0, level - 1);
    reason = '护短，替不在场的人保留';
  }

  // ⑥ 配置里可设硬上限/下限
  const cap = Number(config.maxLevel ?? 3);
  const floor = Number(config.minLevel ?? 0);
  level = Math.max(floor, Math.min(cap, level));

  return { level, reason, subjectPresent };
}

/** 渲染时按等级决定给模型什么素材 */
export function disclosureInstruction(level) {
  if (level >= 3) return null;
  if (level === 2) return '只能概括，不要复述原话或细节';
  if (level === 1) return '只承认你知道，不要展开内容';
  return '不要说，可以礼貌地说不方便讲';
}
