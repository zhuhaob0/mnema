/**
 * 门控：决定"这条要不要记"
 *
 * 两个维度：
 *   1. 关系等级 × 内容类别（4.2 节内容矩阵）
 *   2. 公共场景（群聊）的四条例外
 */

import { atLeastTier } from './relationship.js';

export const CONTENT_CLASSES = ['event', 'preference', 'status', 'feeling', 'secret', 'commitment'];

const DEFAULT_MATRIX = {
  L0: ['event', 'commitment'],
  L1: ['event', 'commitment'],
  L2: ['event', 'preference', 'commitment'],
  L3: ['event', 'preference', 'status', 'feeling', 'commitment'],
  L4: ['event', 'preference', 'status', 'feeling', 'secret', 'commitment'],
};

/**
 * @param {object} input
 * @param {'direct'|'public'} input.channelKind
 * @param {string} input.tier              说话者的关系等级（公共场景用发言者等级）
 * @param {string} input.contentClass
 * @param {object} [input.flags]           { aboutSelf, aboutOwner, collective }
 * @param {object} [config]
 * @returns {{ allow: boolean, reason: string }}
 */
export function gateContent({ channelKind, tier = 'L0', contentClass, flags = {}, config }) {
  const matrix = config?.tiers ?? DEFAULT_MATRIX;
  const allowed = matrix[tier] ?? matrix.L0 ?? [];

  const aboutSelf = flags.aboutSelf === true;
  const aboutOwner = flags.aboutOwner === true;
  const collective = flags.collective === true;

  if (channelKind === 'public') {
    // 公共场景：默认不记人，四条例外
    if (aboutSelf) return { allow: true, reason: '公共场景例外①：与 Actor 自己相关' };
    if (aboutOwner) return { allow: true, reason: '公共场景例外②：与 owner 相关' };
    if (collective) return { allow: true, reason: '公共场景例外③：集体事件' };
    if (atLeastTier(tier, 'L2')) {
      // 例外④：熟人及以上，只记事件与公开信息
      if (contentClass === 'event' || contentClass === 'preference') {
        return { allow: true, reason: '公共场景例外④：熟人以上的公开信息' };
      }
      return { allow: false, reason: '公共场景：熟人以上也不记隐私类内容' };
    }
    return { allow: false, reason: '公共场景：与 Actor/owner 无关且关系不熟，不记' };
  }

  // 一对一场景：按内容矩阵
  if (allowed.includes(contentClass)) {
    return { allow: true, reason: `关系 ${tier} 允许记录 ${contentClass}` };
  }
  return { allow: false, reason: `关系 ${tier} 不够，不记 ${contentClass}` };
}

export { DEFAULT_MATRIX };
