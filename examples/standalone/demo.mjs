#!/usr/bin/env node
/**
 * mnema 最小接入示例（不依赖任何 agent 框架，只用 HTTP）
 *
 * 演示三件事：
 *   1. 写入对话事件   POST /v1/events
 *   2. 按上下文召回   POST /v1/recall
 *   3. 巩固后再次召回  POST /v1/consolidate + /v1/recall
 *
 * 运行：
 *   1) 先启动服务：node src/cli.js serve --port 8321 --db ./data/demo.db
 *   2) node examples/standalone/demo.mjs
 *
 * 环境变量：
 *   MNEMA_URL   服务地址，默认 http://127.0.0.1:8321
 *   MNEMA_TOKEN 服务端开了鉴权时填（会作为 Authorization: Bearer）
 */

const BASE = process.env.MNEMA_URL ?? 'http://127.0.0.1:8321';
const TOKEN = process.env.MNEMA_TOKEN ?? '';
const TENANT = 'demo';
const CHANNEL = { id: 'demo-room', kind: 'direct', participants: ['alice', 'bob'] };

const headers = {
  'content-type': 'application/json',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const say = (text) => console.log(text);

async function main() {
  // 0. 探活
  const health = await (await fetch(`${BASE}/v1/health`)).json();
  say(`✓ mnema ${health.engine} schema v${health.schemaVersion}（embedding: ${health.embedding?.kind}）`);

  // 1. 写入三天的对话事件（同一主题，便于观察巩固）
  //    时间用「相对现在」，否则旧时间戳会被衰减到权重 0，召回和巩固都看不出效果
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  // 三条说法相近的事件，巩固时才会聚类成一条抽象事实
  const events = [
    { role: 'user', text: '我每天早上都要喝一杯手冲咖啡，不加糖', at: daysAgo(2) },
    { role: 'assistant', text: '那你是喜欢偏酸还是偏苦的豆子？', at: daysAgo(2) },
    { role: 'user', text: '我每天早上喝手冲咖啡，不加糖', at: daysAgo(1) },
    { role: 'user', text: '早上起来要喝一杯手冲咖啡，不加糖', at: daysAgo(0) },
  ];
  const ingested = await call('/v1/events', { tenant: TENANT, channel: CHANNEL, events });
  say(`✓ 写入事件 ${events.length} 条（编码 ${ingested.encoded ?? '?'}，跳过 ${ingested.skipped ?? 0}）`);

  // 2. 直接召回：问「我喜欢喝什么」
  const first = await call('/v1/recall', {
    tenant: TENANT,
    channelId: CHANNEL.id,
    participants: CHANNEL.participants,
    query: '我喜欢喝什么咖啡',
    budget: { maxItems: 5 },
  });
  say(`\n— 巩固前召回（候选 ${first.stats?.candidates}，返回 ${first.stats?.returned}）—`);
  for (const item of first.items ?? []) {
    const level = item.disclosure?.level ?? '?';
    say(`  [${item.kind}] ${String(item.text ?? '').slice(0, 40)}  score=${Number(item.score ?? 0).toFixed(2)}  披露=L${level}`);
  }

  // 3. 巩固（仿睡眠：事件聚类 → 抽象事实）
  const consolidated = await call('/v1/consolidate', { tenant: TENANT });
  say(`\n✓ 巩固完成：扫描 ${consolidated.scanned ?? '?'} 条，新建事实 ${consolidated.factsCreated ?? 0}，合并 ${consolidated.merged ?? 0}`);

  // 4. 巩固后再召回：应该出现抽象出的事实（kind=fact）
  const second = await call('/v1/recall', {
    tenant: TENANT,
    channelId: CHANNEL.id,
    participants: CHANNEL.participants,
    query: '他的咖啡偏好',
    budget: { maxItems: 5 },
  });
  say(`\n— 巩固后召回（候选 ${second.stats?.candidates}，返回 ${second.stats?.returned}）—`);
  for (const item of second.items ?? []) {
    say(`  [${item.kind}] ${String(item.text ?? '').slice(0, 40)}  score=${Number(item.score ?? 0).toFixed(2)}`);
  }

  say('\n完成。核心只有 HTTP：换成任何语言/框架，接法完全一样。');
}

main().catch((error) => {
  console.error('\n✗ 失败：' + (error?.message ?? error));
  console.error('  请先启动服务：node src/cli.js serve --port 8321 --db ./data/demo.db');
  process.exit(1);
});
