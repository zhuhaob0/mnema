import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';

const makeEngine = () => createEngine({
  dbPath: ':memory:',
  config: { tenant: 't1', embedding: { kind: 'hash', dim: 32 } },
});

test('import: 事件与事实可批量导入并跳过编码', async () => {
  const engine = makeEngine();
  const result = await engine.importMemories({
    events: [
      { text: '他最近在考虑跳槽', at: '2026-10-01T10:00:00Z', participants: ['self', 'user:1'], contentClass: 'status', sensitivity: 'contact' },
      { text: '今天天气不错', at: '2026-10-02T10:00:00Z', participants: ['self', 'user:1'], contentClass: 'event' },
    ],
    facts: [
      { text: '他打算跳槽但担心稳定性', participants: ['self', 'user:1'], contentClass: 'status', sensitivity: 'contact', at: '2026-10-01T10:00:00Z' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.importedEvents, 2);
  assert.equal(result.importedFacts, 1);

  const stats = engine.stats();
  assert.equal(stats.events, 2);
  assert.equal(stats.facts, 1);
  engine.close();
});

test('import: 导入后能被检索到', async () => {
  const engine = makeEngine();
  await engine.importMemories({
    facts: [
      { text: '他特别喜欢猫，家里养了两只布偶', participants: ['self', 'user:1'], contentClass: 'preference', sensitivity: 'contact', at: '2026-10-01T00:00:00Z' },
    ],
  });

  const recalled = await engine.recall({
    channelId: 'chat:user:1',
    participants: ['self', 'user:1'],
    query: '猫',
  });
  assert.ok(recalled.items.length >= 1);
  assert.match(recalled.rendered, /猫/);
  engine.close();
});

test('import: 交互流会推动关系度', async () => {
  const engine = makeEngine();
  const result = await engine.importMemories({
    interactions: Array.from({ length: 20 }, (_, i) => ({
      contactId: 'user:1',
      channelId: 'chat:user:1',
      at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      chars: 30,
      emotion: 'anxiety',
    })),
  });
  assert.equal(result.importedInteractions, 20);
  assert.equal(result.contacts, 1);

  const rel = engine.relationship('user:1');
  assert.ok(rel, '应建立关系记录');
  assert.ok(rel.score > 0.2, `关系度应被交互推动，实际 ${rel.score}`);
  engine.close();
});

test('import: 空文本被跳过', async () => {
  const engine = makeEngine();
  const result = await engine.importMemories({
    events: [{ text: '   ' }, { text: '' }],
    facts: [{ text: '' }],
  });
  assert.equal(result.importedEvents, 0);
  assert.equal(result.importedFacts, 0);
  engine.close();
});

test('import: 显式 sensitivity 会被保留（不经过门控改写）', async () => {
  const engine = makeEngine();
  await engine.importMemories({
    facts: [
      { text: '主人留下的背景：他喜欢猫', participants: [], contentClass: 'preference', sensitivity: 'shared', at: '2026-10-01T00:00:00Z' },
    ],
  });
  const [fact] = engine.memories({ kind: 'semantic' });
  assert.equal(fact.sensitivity, 'shared');
  engine.close();
});
