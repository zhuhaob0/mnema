/**
 * 配置：默认值 + 文件 + 环境变量覆盖
 */

export const DEFAULTS = {
  tenant: 'default',
  storage: { kind: 'sqlite', path: './data/mnema.db' },
  http: { host: '127.0.0.1', port: 8321, token: '' },
  embedding: {
    // auto = 先试 sidecar，失败退回 hash（离线可用）
    kind: 'auto',
    url: 'http://127.0.0.1:8331',
    model: 'bge-small-zh-v1.5',
    dim: 256,
    timeoutMs: 4000,
  },
  encoder: { kind: 'heuristic' }, // heuristic | llm（P2 接）
  gate: {
    // 关系等级 → 允许的内容类别
    tiers: {
      L0: ['event', 'commitment'],
      L1: ['event', 'commitment'],
      L2: ['event', 'preference', 'commitment'],
      L3: ['event', 'preference', 'status', 'feeling', 'commitment'],
      L4: ['event', 'preference', 'status', 'feeling', 'secret', 'commitment'],
    },
    publicExceptions: ['self', 'owner', 'collective', 'knownContact'],
  },
  relationship: {
    weights: { freq: 0.25, span: 0.15, depth: 0.2, emotion: 0.15, mutual: 0.15, memories: 0.1 },
    smoothing: 0.7,
    thresholds: { L1: 0.15, L2: 0.35, L3: 0.6, L4: 0.8 },
    decayPerWeek: 0.9,
    decayAfterDays: 30,
    floor: 0.05,
  },
  recall: {
    weights: { sim: 0.35, participant: 0.2, freshness: 0.15, relationship: 0.15, salience: 0.1, access: 0.05 },
    maxItems: 10,
    candidatePool: 300,
  },
  decay: { topic: 3, event: 30, fact: 365, narrative: 0, floor: 0.15, emotionalMultiplier: 3 },
  // 披露策略（记得 ≠ 该说）
  disclosure: { maxLevel: 3, minLevel: 0 },
  // 叙事自我（每天巩固时重写；owner 只读）
  narrative: { enabled: true, maxEvents: 40, maxContacts: 5 },
  // 性格参数（owner 可改）；影响披露宽严
  personaTraits: { discretion: 0.5, gossip: 0.3, protectiveness: 0.5 },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 环境变量覆盖（MNEMA_*） */
export function applyEnv(config, env = process.env) {
  const out = deepMerge(config, {});
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  if (env.MNEMA_TENANT) out.tenant = env.MNEMA_TENANT;
  if (env.MNEMA_DB) out.storage.path = env.MNEMA_DB;
  if (env.MNEMA_HTTP_PORT) out.http.port = num(env.MNEMA_HTTP_PORT) ?? out.http.port;
  if (env.MNEMA_HTTP_HOST) out.http.host = env.MNEMA_HTTP_HOST;
  if (env.MNEMA_HTTP_TOKEN) out.http.token = env.MNEMA_HTTP_TOKEN;
  if (env.MNEMA_EMBED_URL) out.embedding.url = env.MNEMA_EMBED_URL;
  if (env.MNEMA_EMBED_KIND) out.embedding.kind = env.MNEMA_EMBED_KIND;
  if (env.MNEMA_EMBED_DIM) out.embedding.dim = num(env.MNEMA_EMBED_DIM) ?? out.embedding.dim;
  if (env.MNEMA_ENCODER) out.encoder.kind = env.MNEMA_ENCODER;
  return out;
}

export function normalizeConfig(config = {}, env = process.env) {
  const merged = deepMerge(DEFAULTS, config ?? {});
  return applyEnv(merged, env);
}
