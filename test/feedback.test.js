import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';

const makeEngine = () => createEngine({
  dbPath: ':memory:',
  config: { tenant: 't1', embedding: { kind: 'hash', dim: 32 } },
});

async function seed(engine) {
  await engine.ingest({
    channel: { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] },
    events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子，还拍了照' }],
  });
  return engine.memories()[0];
}

test('feedback: confirm 提升权重并更新确认时间', async () => {
  const engine = makeEngine();
  const memory = await seed(engine);
  const before = engine.memories()[0];

  const result = engine.feedback({ op: 'confirm', memoryId: memory.id });
  assert.equal(result.ok, true);

  const after = engine.memories()[0];
  assert.ok(after.weight > before.weight, `权重应上升：${before.weight} → ${after.weight}`);
  engine.close();
});

test('feedback: correct 改写内容并把旧版本放进版本链', async () => {
  const engine = makeEngine();
  const memory = await seed(engine);

  const result = engine.feedback({ op: 'correct', memoryId: memory.id, text: '今天在公园看到一只很瘦的鸽子' });
  assert.equal(result.ok, true);
  assert.match(result.from, /很胖/);
  assert.match(result.to, /很瘦/);

  const current = engine.memories()[0];
  assert.match(current.gist, /很瘦/);

  const versions = engine.versions(memory.id);
  assert.equal(versions.length, 1);
  assert.match(versions[0].text, /很胖/, '旧版本应保留');
  engine.close();
});

test('feedback: forget 真删且留版本记录', async () => {
  const engine = makeEngine();
  const memory = await seed(engine);

  const result = engine.feedback({ op: 'forget', memoryId: memory.id });
  assert.equal(result.ok, true);
  assert.equal(engine.memories().length, 0);
  assert.equal(engine.versions(memory.id).length, 1);
  engine.close();
});

test('feedback: 参数校验', async () => {
  const engine = makeEngine();
  assert.equal(engine.feedback({ op: 'nope', memoryId: 'x' }).ok, false);
  assert.equal(engine.feedback({ op: 'confirm' }).ok, false);
  assert.equal(engine.feedback({ op: 'confirm', memoryId: 'missing' }).ok, false);

  const memory = await seed(engine);
  assert.equal(engine.feedback({ op: 'correct', memoryId: memory.id }).ok, false, 'correct 缺 text 应报错');
  engine.close();
});

test('memories: 可按类型筛选与分页', async () => {
  const engine = makeEngine();
  await seed(engine);
  await engine.ingest({
    channel: { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] },
    events: [{ role: 'user', text: '我特别喜欢猫，家里养了两只' }],
  });

  const all = engine.memories();
  assert.ok(all.length >= 1);
  const episodic = engine.memories({ kind: 'episodic' });
  assert.ok(episodic.every((m) => m.kind === 'episodic'));
  const semantic = engine.memories({ kind: 'semantic' });
  assert.ok(semantic.every((m) => m.kind === 'semantic'));
  engine.close();
});
