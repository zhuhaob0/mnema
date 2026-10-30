import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterBySimilarity, decayWeight, extractFactText, mergeDecision, HALF_LIFE,
} from '../src/core/consolidate.js';
import { createEngine } from '../src/engine.js';

const vec = (...xs) => Float32Array.from(xs);
const makeEngine = () => createEngine({
  dbPath: ':memory:',
  config: { tenant: 't1', embedding: { kind: 'hash', dim: 64 } },
});

test('聚类：相似向量进同一簇，不同向量分开', () => {
  const items = [
    { id: 'a', embedding: vec(1, 0, 0) },
    { id: 'b', embedding: vec(1, 0, 0.01) },
    { id: 'c', embedding: vec(0, 1, 0) },
  ];
  const clusters = clusterBySimilarity(items, { threshold: 0.9 });
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
});

test('抽象：取显著度最高的一条作为事实', () => {
  const text = extractFactText([
    { gist: '普通的一条', salience: 0.3 },
    { gist: '他说想跳槽但担心不稳定', salience: 0.9 },
  ]);
  assert.match(text, /跳槽/);
});

test('衰减：一个半衰期权重减半', () => {
  const at = new Date('2026-01-01T00:00:00Z').toISOString();
  const now = new Date('2026-01-31T00:00:00Z').getTime(); // 30 天
  const w = decayWeight(0.8, at, { now, halfLifeDays: HALF_LIFE.event });
  assert.ok(Math.abs(w - 0.4) < 0.02, `期望约 0.4，实际 ${w}`);
});

test('合并判定：0.92 / 0.75 分档', () => {
  assert.equal(mergeDecision(0.95), 'merge');
  assert.equal(mergeDecision(0.8), 'similar');
  assert.equal(mergeDecision(0.5), 'new');
});

test('巩固：重复事件被抽象成一条事实，且再次巩固不重复建', async () => {
  const engine = makeEngine();
  const channel = { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] };
  const text = '今天在公园看到一只很胖的鸽子，还拍了照片';

  for (let i = 0; i < 3; i += 1) {
    await engine.ingest({
      channel,
      events: [{ role: 'user', text, at: `2026-10-0${i + 1}T10:00:00Z` }],
    });
  }
  const before = engine.stats();
  assert.equal(before.events, 3, '应有 3 条事件');
  assert.equal(before.facts, 0, '事件类内容不直接产事实');

  const first = await engine.consolidate({ now: new Date('2026-10-05T00:00:00Z').getTime() });
  assert.equal(first.scanned, 3);
  assert.equal(first.factsCreated, 1, '三条相似事件应抽象成一条事实');
  assert.equal(engine.stats().facts, 1);

  const second = await engine.consolidate({ now: new Date('2026-10-06T00:00:00Z').getTime() });
  assert.equal(second.scanned, 0, '水位之后没有新事件');
  assert.equal(engine.stats().facts, 1, '不应重复建事实');
  engine.close();
});

test('巩固：旧事件被衰减（沉底后不再进常规检索）', async () => {
  const engine = makeEngine({
    config: {
      tenant: 't1',
      embedding: { kind: 'hash', dim: 64 },
      decay: { topic: 3, event: 30, fact: 365, narrative: 0, floor: 0.15, emotionalMultiplier: 3 },
    },
  });
  const channel = { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] };
  await engine.ingest({
    channel,
    events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子', at: '2026-01-01T00:00:00Z' }],
  });

  const result = await engine.consolidate({ now: new Date('2026-10-30T00:00:00Z').getTime() });
  assert.ok(result.decayed >= 1, '应有内容被衰减');

  const recalled = await engine.recall({
    channelId: channel.id,
    participants: channel.participants,
    query: '鸽子',
  });
  assert.equal(recalled.items.length, 0, '衰减到阈值以下的记忆不再参与常规检索');
  engine.close();
});

test('巩固：会重算关系度', async () => {
  const engine = makeEngine();
  const channel = { id: 'chat:user:2', kind: 'direct', participants: ['self', 'user:2'] };
  for (let i = 0; i < 3; i += 1) {
    await engine.ingest({
      channel,
      events: [{ role: 'user', text: `今天又加班到很晚，压力很大，第 ${i + 1} 次` }],
    });
  }
  const result = await engine.consolidate();
  assert.equal(result.ok, true);
  const rel = engine.relationship('user:2');
  assert.ok(rel.history.length >= 2, '关系历史应有新记录');
  engine.close();
});
