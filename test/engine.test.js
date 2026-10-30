import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';

function makeEngine(over = {}) {
  return createEngine({
    dbPath: ':memory:',
    config: {
      tenant: 't1',
      embedding: { kind: 'hash', dim: 64 },
      ...over,
    },
  });
}

const direct = (n) => ({ id: `chat:user:${n}`, kind: 'direct', participants: ['self', `user:${n}`] });

test('ingest：寒暄被跳过，事件类内容被记录', async () => {
  const engine = makeEngine();
  const result = await engine.ingest({
    channel: direct(1),
    events: [
      { role: 'user', text: '在吗' },
      { role: 'user', text: '今天在楼下捡到一只小猫，带它去看了医生', at: '2026-10-30T10:00:00Z' },
    ],
  });
  assert.equal(result.accepted, 2);
  assert.equal(result.encoded, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.reasons.some((r) => /寒暄/.test(r)));
  engine.close();
});

test('ingest：关系不熟时隐私内容被门控拦下（但互动仍计数）', async () => {
  const engine = makeEngine();
  const result = await engine.ingest({
    channel: direct(9),
    events: [{ role: 'user', text: '只跟你说个秘密，我其实被裁了' }],
  });
  assert.equal(result.encoded, 0);
  assert.equal(result.skipped, 1);
  assert.ok(result.reasons.some((r) => /不记/.test(r)));

  const rel = engine.relationship('user:9');
  assert.ok(rel, '即使没记住内容，也应因为聊过而建立关系记录');
  assert.ok(rel.signals.eventCount >= 1, '交互流应被计入关系度');
  engine.close();
});

test('关系度随互动积累上升（不受门控影响）', async () => {
  const engine = makeEngine();
  const channel = direct(1);
  const first = await engine.ingest({
    channel,
    events: [{ role: 'user', text: '我今天很焦虑，压力特别大' }],
  });
  const afterFirst = engine.relationship('user:1');

  for (let i = 0; i < 6; i += 1) {
    await engine.ingest({
      channel,
      events: [{ role: 'user', text: `我今天还是很焦虑，压力特别大，第 ${i + 2} 次跟你说这事` }],
    });
  }
  const afterMany = engine.relationship('user:1');

  assert.ok(afterFirst.score > 0, '第一次互动就应有分数');
  assert.ok(afterMany.score > afterFirst.score, `累积互动后应上升：${afterFirst.score} → ${afterMany.score}`);
  assert.equal(first.encoded, 0, 'L0 不该记住情绪类内容，但互动要计入');
  engine.close();
});

test('recall：能召回相关记忆，且不越权', async () => {
  const engine = makeEngine();
  await engine.ingest({
    channel: direct(1),
    events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子，还拍了照' }],
  });
  await engine.ingest({
    channel: direct(2),
    events: [{ role: 'user', text: '今天在公司楼下遇到一只流浪猫' }],
  });

  const mine = await engine.recall({
    channelId: 'chat:user:1',
    participants: ['self', 'user:1'],
    query: '鸽子',
  });
  assert.ok(mine.items.length >= 1);
  assert.match(mine.rendered, /鸽子/);

  const noLeak = await engine.recall({
    channelId: 'chat:user:1',
    participants: ['self', 'user:1'],
    query: '流浪猫',
  });
  assert.equal(noLeak.items.some((i) => /流浪猫/.test(i.text)), false, '不应检索到别的会话的记忆');
  engine.close();
});

test('recall：熟人以上的公开偏好可以跨会话被想起', async () => {
  const engine = makeEngine();
  const channel = direct(3);
  // 先聊够，把关系抬到 L2+
  for (let i = 0; i < 30; i += 1) {
    await engine.ingest({
      channel,
      events: [{ role: 'user', text: `今天又是加班的一天，压力很大，第 ${i + 1} 次跟你说` }],
    });
  }
  const rel = engine.relationship('user:3');
  assert.ok(['L2', 'L3', 'L4'].includes(rel.tier), `应至少 L2，实际 ${rel.tier}`);

  const encoded = await engine.ingest({
    channel,
    events: [{ role: 'user', text: '我特别喜欢猫，家里养了两只布偶' }],
  });
  assert.equal(encoded.encoded, 1, 'L2 应能记住公开偏好');
  engine.close();
});

test('persona 可写、narrative 只读接口存在', () => {
  const engine = makeEngine();
  const saved = engine.setPersona('# 性格底色\n- 嘴上毒心里软');
  assert.match(saved.markdown, /嘴上毒/);
  assert.equal(engine.narrative(), null, '叙事在 P1 尚未生成，应为 null');
  engine.close();
});

test('stats 反映写入量', async () => {
  const engine = makeEngine();
  await engine.ingest({
    channel: direct(1),
    events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子' }],
  });
  const s = engine.stats();
  assert.ok(s.events >= 1);
  assert.ok(s.relationships >= 1);
  assert.ok(s.channels >= 1);
  engine.close();
});
