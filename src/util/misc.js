/**
 * 小工具：id、时间、向量、文本相似
 */

import crypto from 'node:crypto';

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function daysBetween(a, b) {
  const ms = Math.abs(new Date(b).getTime() - new Date(a).getTime());
  return ms / 86400000;
}

/** 对数归一化到 0~1（x>=cap 时为 1） */
export function logScale(value, cap) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const v = Math.log1p(value) / Math.log1p(cap);
  return Math.max(0, Math.min(1, v));
}

export function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Float32Array ↔ Buffer */
export function vectorToBuffer(vec) {
  if (!vec) return null;
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToVector(buf) {
  if (!buf) return null;
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '我', '你', '他', '她', '它', '们',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'it',
]);

/** 极简分词：中文按字 bigram + 英文/数字按词 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const m of s.matchAll(/[a-z0-9]{2,}/g)) tokens.push(m[0]);
  const han = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const chunk of han.split(/\s+/)) {
    if (!chunk) continue;
    if (chunk.length === 1) tokens.push(chunk);
    for (let i = 0; i + 1 < chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2));
  }
  return tokens.filter((t) => t && !STOPWORDS.has(t));
}

/** 关键词重叠分（0~1），用于无 embedding 时的降级 */
export function keywordScore(query, text) {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const t = new Set(tokenize(text));
  if (t.size === 0) return 0;
  let hit = 0;
  for (const token of q) if (t.has(token)) hit += 1;
  return hit / q.size;
}
