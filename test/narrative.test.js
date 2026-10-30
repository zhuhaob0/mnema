import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateNarrative } from '../src/core/narrative.js';
import { createEngine } from '../src/engine.js';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const makeEngine = () => createEngine({
  dbPath: ':memory:',
  config: { tenant: 't1', embedding: { kind: 'hash', dim: 64 } },
});

test('叙事：空数据也能生成骨架', () => {
  const md = generateNarrative({ now: NOW });
  assert.match(md, /# 我的状态（2026-10-30 更新）/);
  assert.match(md, /我最近在做什么/);
  assert.match(md, /我和谁关系怎样/);
  assert.match(md, /我最近的想法/);
  assert.match(md, /没什么特别的事/);
  assert.match(md, /还没跟谁真正熟起来/);
});

test('叙事：包含近期互动对象与话题', () => {
  const md = generateNarrative({
    now: NOW,
    events: [
      { at: daysAgo(1), participants: ['self', 'user:197196327'], contentClass: 'status', emotion: 'anxiety' },
      { at: daysAgo(2), participants: ['self', 'user:197196327'], contentClass: 'status', emotion: 'anxiety' },
      { at: daysAgo(3), participants: ['self', 'user:197196327'], contentClass: 'event', emotion: 'neutral' },
    ],
    relationships: [{ contactId: 'user:197196327', tier: 'L2', score: 0.42, lastInteract: daysAgo(1) }],
  });
  assert.match(md, /197196327/);
  assert.match(md, /聊了 3 次/);
  assert.match(md, /近况/);
  assert.match(md, /焦虑/);
  assert.match(md, /算熟（0.42）/);
});

test('叙事：只统计近 7 天', () => {
  const md = generateNarrative({
    now: NOW,
    events: [
      { at: daysAgo(1), participants: ['self', 'user:1'], contentClass: 'event' },
      { at: daysAgo(30), participants: ['self', 'user:9'], contentClass: 'event' },
    ],
  });
  assert.match(md, /user:1|1/);
  assert.doesNotMatch(md, /user:9/);
});

test('叙事：记忆里的长期事实会出现在"想法"里', () => {
  const md = generateNarrative({
    now: NOW,
    facts: [{ text: '他打算跳槽但担心稳定性', lastConfirmedAt: daysAgo(1) }],
  });
  assert.match(md, /记得他打算跳槽/);
});

test('巩固会重写叙事并记录时间', async () => {
  const engine = makeEngine();
  const channel = { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] };
  await engine.ingest({ channel, events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子' }] });
  await engine.ingest({ channel, events: [{ role: 'user', text: '今天又去公园看鸽子了，还带了面包' }] });

  const result = await engine.consolidate({ now: NOW });
  assert.equal(result.narrativeUpdated, true);

  const narrative = engine.narrative();
  assert.ok(narrative?.markdown, '应写入叙事');
  assert.match(narrative.markdown, /我的状态/);
  engine.close();
});

test('recall 会把叙事放在最前面', async () => {
  const engine = makeEngine();
  const channel = { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] };
  await engine.ingest({ channel, events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子' }] });
  engine.regenerateNarrative({ now: NOW });

  const recalled = await engine.recall({
    channelId: channel.id,
    participants: channel.participants,
    query: '鸽子',
  });
  const text = recalled.rendered;
  assert.ok(text.indexOf('你最近的状况') >= 0, '应包含叙事段');
  assert.ok(text.indexOf('你最近的状况') < text.indexOf('你记得的'), '叙事应排在记忆前面');
  engine.close();
});

test('regenerateNarrative 可单独调用（不跑完整巩固）', () => {
  const engine = makeEngine();
  const result = engine.regenerateNarrative({ now: NOW });
  assert.match(result.markdown, /我的状态/);
  assert.ok(result.updatedAt);
  engine.close();
});

test('narrative 关闭时巩固不写叙事', async () => {
  const engine = createEngine({
    dbPath: ':memory:',
    config: { tenant: 't1', embedding: { kind: 'hash', dim: 32 }, narrative: { enabled: false } },
  });
  const channel = { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] };
  await engine.ingest({ channel, events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子' }] });
  const result = await engine.consolidate({ now: NOW });
  assert.equal(result.narrativeUpdated, false);
  assert.equal(engine.narrative(), null);
  engine.close();
});
