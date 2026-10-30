/**
 * Embedding：可插拔
 *  - hash：确定性伪向量，零依赖、离线可用（默认降级）
 *  - http：调用本地 sidecar（/embed），真实语义向量
 *  - auto：先 http，失败退回 hash（并记录降级状态）
 */

import crypto from 'node:crypto';

function hashVector(text, dim) {
  // 基于 token 的哈希桶累加，保证同样的文本得到同样的向量
  const arr = new Float32Array(dim);
  const tokens = String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]/g) ?? [];
  if (tokens.length === 0) return arr;
  for (const token of tokens) {
    const digest = crypto.createHash('md5').update(token).digest();
    const idx = digest.readUInt32LE(0) % dim;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    arr[idx] += sign;
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) arr[i] /= norm;
  return arr;
}

async function httpEmbed(texts, config) {
  const { url, model, timeoutMs = 4000 } = config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts, model }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const data = await res.json();
    const vectors = data?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error('embed 返回格式不正确');
    }
    return vectors.map((v) => Float32Array.from(v));
  } finally {
    clearTimeout(timer);
  }
}

export class EmbeddingProvider {
  constructor(config = {}) {
    this.config = config;
    this.kind = config.kind ?? 'auto';
    this.dim = Number(config.dim) || 256;
    this.degraded = false;
    this.degradedReason = null;
  }

  get activeKind() {
    if (this.kind === 'hash') return 'hash';
    if (this.kind === 'http') return 'http';
    return this.degraded ? 'hash' : 'http';
  }

  async embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (this.kind === 'hash') return list.map((t) => hashVector(t, this.dim));

    try {
      const vectors = await httpEmbed(list, this.config);
      this.degraded = false;
      return vectors;
    } catch (error) {
      if (this.kind === 'http') throw error;
      this.degraded = true;
      this.degradedReason = error?.message ?? String(error);
      return list.map((t) => hashVector(t, this.dim));
    }
  }

  async embedOne(text) {
    const [vec] = await this.embed([text]);
    return vec;
  }
}

export { hashVector };
