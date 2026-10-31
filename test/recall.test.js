import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankMemories, renderMemories, sensitivityAllows } from '../src/core/recall.js';
import { keywordScore, tokenize } from '../src/util/misc.js';
import { createEngine } from '../src/engine.js';

const baseItem = (over = {}) => ({
  id: over.id ?? 'x',
  channelId: 'chat:1',
  participants: ['user:1'],
  gist: '默认内容',
  tags: [],
  weight: 0.8,
  salience: 0.5,
  accessCount: 0,
  ...over,
});

test('隐私围栏：channel 级别只能在本会话被检索', () => {
  const item = baseItem({ sensitivity: 'channel', channelId: 'chat:1' });
  assert.equal(sensitivityAllows(item, { channelId: 'chat:1', participants: ['user:1'] }), true);
  assert.equal(sensitivityAllows(item, { channelId: 'chat:2', participants: ['user:2'] }), false);
});

test('隐私围栏：contact 级别只在与该联系人相关时可见', () => {
  const item = baseItem({ sensitivity: 'contact', participants: ['user:1'] });
  assert.equal(sensitivityAllows(item, { channelId: 'chat:9', participants: ['user:1'] }), true);
  assert.equal(sensitivityAllows(item, { channelId: 'chat:9', participants: ['user:2'] }), false);
});

test('隐私围栏：shared 级别任何会话可见', () => {
  const item = baseItem({ sensitivity: 'shared' });
  assert.equal(sensitivityAllows(item, { channelId: 'chat:9', participants: ['user:9'] }), true);
});

test('排序：与查询更相关的排前面', () => {
  const items = [
    baseItem({ id: 'a', gist: '他今天去超市买了牛奶' }),
    baseItem({ id: 'b', gist: '他说想跳槽但担心不稳定' }),
  ];
  const scored = rankMemories({
    items,
    query: '跳槽的事情怎么样了',
    queryVector: null,
    channelId: 'chat:1',
    participants: ['user:1'],
    relationships: { 'user:1': { score: 0.5, tier: 'L2' } },
    config: {},
    preferKeyword: true,
  });
  assert.equal(scored[0].item.id, 'b');
});

test('排序：同一相关度下，新近（weight 高）优先', () => {
  const items = [
    baseItem({ id: 'old', gist: '跳槽', weight: 0.2 }),
    baseItem({ id: 'new', gist: '跳槽', weight: 0.9 }),
  ];
  const scored = rankMemories({
    items,
    query: '跳槽',
    queryVector: null,
    channelId: 'chat:1',
    participants: ['user:1'],
    relationships: {},
    config: {},
    preferKeyword: true,
  });
  assert.equal(scored[0].item.id, 'new');
});

test('渲染：包含标题与条目，空结果有占位', () => {
  const scored = rankMemories({
    items: [baseItem({ gist: '他喜欢猫' })],
    query: '猫',
    queryVector: null,
    channelId: 'chat:1',
    participants: ['user:1'],
    relationships: {},
    config: {},
    preferKeyword: true,
  });
  const out = renderMemories(scored, { maxItems: 5, narrative: '我最近在帮他找工作' });
  assert.match(out.rendered, /你最近的状况/);
  assert.match(out.rendered, /你记得的/);
  assert.match(out.rendered, /他喜欢猫/);
  assert.equal(out.items.length, 1);

  const empty = renderMemories([], { maxItems: 5 });
  assert.match(empty.rendered, /没有相关的记忆/);
});

test('分词与关键词分：中文 bigram 能命中', () => {
  assert.ok(tokenize('跳槽').includes('跳槽'));
  assert.ok(keywordScore('跳槽', '他说想跳槽但担心') > 0);
  assert.equal(keywordScore('完全无关的词', '跳槽'), 0);
});

test('召回：其它会话的 shared 记忆会补进 rendered（私聊问得出群聊的事）', async () => {
  const engine = createEngine({ dbPath: ':memory:' });
  const at = new Date().toISOString();
  await engine.ingest({
    tenant: 't',
    channel: { id: 'chat:group:9', kind: 'public', participants: ['self', 'group:9'], recordPublic: true },
    events: [{ role: 'user', text: '周六下午三点公园门口集合去爬山', at, sensitivity: 'shared' }],
  });
  await engine.ingest({
    tenant: 't',
    channel: { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] },
    events: [{ role: 'user', text: '今天代码写完了', at, sensitivity: 'channel' }],
  });
  const r = await engine.recall({ tenant: 't', channelId: 'chat:user:1', participants: ['self', 'user:1'], query: '最近怎么样' });
  assert.ok(r.sharedRecent.length >= 1, '应带出其它会话的共享记忆');
  assert.match(r.rendered, /爬山/);
  engine.close();
});
