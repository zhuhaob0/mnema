/**
 * 叙事自我（自传体记忆）
 *
 * 与 persona 的分工：
 *   persona  = 性格底色（owner 可改）
 *   narrative = 经历沉淀（由"我"自己写，owner 只能看）
 *
 * P3 是规则版生成；将来换 LLM 只替换 generateNarrative 的实现，接口不变。
 */

const DAY = 86400000;

function withinDays(at, now, days) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= days * DAY;
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function countBy(items, pick) {
  const map = new Map();
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/**
 * @param {object} input
 * @param {Array}  input.events       全部事件（按 at 倒序更佳，但内部会排序）
 * @param {Array}  input.facts        语义事实
 * @param {Array}  input.relationships
 * @param {string} [input.persona]    性格文本（影响语气，规则版只做轻量引用）
 * @param {number} [input.now]
 */
export function generateNarrative({
  events = [], facts = [], relationships = [], persona = '', now = Date.now(), maxEvents = 40, maxContacts = 5,
} = {}) {
  const date = new Date(now).toISOString().slice(0, 10);
  const recent = events
    .filter((e) => withinDays(e.at, now, 7))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, maxEvents);

  const lines = [`# 我的状态（${date} 更新）`, ''];

  // ── 我最近在做什么 ──
  lines.push('## 我最近在做什么');
  if (recent.length === 0) {
    lines.push('- 最近一周没什么特别的事，安安静静的。');
  } else {
    const who = topN(countBy(recent, (e) => (e.participants ?? []).find((p) => p !== 'self')), 3)
      .map(([id]) => id.replace(/^user:/, ''));
    const topics = topN(countBy(recent, (e) => e.contentClass), 3).map(([c]) => classLabel(c));
    const emotions = topN(countBy(recent, (e) => (e.emotion && e.emotion !== 'neutral' ? e.emotion : null)), 2)
      .map(([e]) => emotionLabel(e));

    if (who.length) lines.push(`- 这几天主要跟 ${who.join('、')} 打交道，一共聊了 ${recent.length} 次。`);
    if (topics.length) lines.push(`- 聊得比较多的是${topics.join('、')}。`);
    if (emotions.length) lines.push(`- 听到的情绪里，${emotions.join('、')}居多。`);
  }
  lines.push('');

  // ── 我和谁关系怎样 ──
  lines.push('## 我和谁关系怎样');
  const contacts = [...relationships].sort((a, b) => b.score - a.score).slice(0, maxContacts);
  if (contacts.length === 0) {
    lines.push('- 还没跟谁真正熟起来。');
  } else {
    for (const rel of contacts) {
      const id = String(rel.contactId ?? '').replace(/^user:/, '');
      const tier = rel.tier ?? 'L0';
      const note = rel.lastInteract ? `，最近一次是 ${String(rel.lastInteract).slice(0, 10)}` : '';
      lines.push(`- ${id}：${tierLabel(tier)}（${Number(rel.score ?? 0).toFixed(2)}）${note}`);
    }
  }
  lines.push('');

  // ── 我最近的想法 ──
  lines.push('## 我最近的想法');
  const thoughts = [];
  const recentFacts = [...facts]
    .sort((a, b) => new Date(b.lastConfirmedAt ?? b.firstAt ?? 0) - new Date(a.lastConfirmedAt ?? a.firstAt ?? 0))
    .slice(0, 3);
  for (const fact of recentFacts) {
    const text = String(fact.text ?? '').trim();
    if (text) thoughts.push(`- 记得${text}`);
  }
  const anxious = recent.filter((e) => e.emotion === 'anxiety').length;
  if (anxious >= 2) thoughts.push('- 最近听到的焦虑不少，我想多留意一下。');
  const happy = recent.filter((e) => e.emotion === 'happy').length;
  if (happy >= 2) thoughts.push('- 这几天有几件挺开心的事，我记着了。');
  if (thoughts.length === 0) thoughts.push('- 暂时没什么特别在意的。');
  lines.push(...thoughts);

  if (persona) {
    lines.push('', '<!-- 语气参考：persona（性格）由 owner 维护，这里只写经历 -->');
  }

  return `${lines.join('\n')}\n`;
}

function classLabel(contentClass) {
  return {
    event: '日常',
    preference: '喜好',
    status: '近况',
    feeling: '情绪',
    secret: '心事',
    commitment: '约定',
  }[contentClass] ?? contentClass;
}

function emotionLabel(emotion) {
  return {
    sad: '难过',
    anxiety: '焦虑',
    angry: '烦躁',
    happy: '开心',
    tired: '疲惫',
    neutral: '平静',
  }[emotion] ?? emotion;
}

function tierLabel(tier) {
  return { L0: '还陌生', L1: '刚认识', L2: '算熟', L3: '是朋友', L4: '很亲近' }[tier] ?? tier;
}
