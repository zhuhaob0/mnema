import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';
import { createMcpServer, TOOLS } from '../src/mcp/server.js';

const makeEngine = () => createEngine({
  dbPath: ':memory:',
  config: { tenant: 't1', embedding: { kind: 'hash', dim: 32 } },
});

test('MCP: initialize 返回协议版本与 serverInfo', async () => {
  const engine = makeEngine();
  const server = createMcpServer(engine);
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.equal(res.result.serverInfo.name, 'mnema');
  assert.ok(res.result.capabilities.tools);
  engine.close();
});

test('MCP: tools/list 暴露 7 个工具', async () => {
  const engine = makeEngine();
  const server = createMcpServer(engine);
  const res = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.result.tools.length, 7);
  const names = res.result.tools.map((t) => t.name);
  for (const expected of ['mnema_remember', 'mnema_recall', 'mnema_relationships', 'mnema_narrative', 'mnema_persona', 'mnema_forget', 'mnema_stats']) {
    assert.ok(names.includes(expected), `缺少 ${expected}`);
  }
  engine.close();
});

test('MCP: remember → recall 闭环', async () => {
  const engine = makeEngine();
  const server = createMcpServer(engine);

  const remembered = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'mnema_remember',
      arguments: {
        text: '今天在公园看到一只很胖的鸽子，还拍了照',
        channelId: 'chat:user:1',
        participants: ['self', 'user:1'],
      },
    },
  });
  const payload = JSON.parse(remembered.result.content[0].text);
  assert.equal(payload.encoded, 1);

  const recalled = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'mnema_recall',
      arguments: { query: '鸽子', channelId: 'chat:user:1', participants: ['self', 'user:1'] },
    },
  });
  const found = JSON.parse(recalled.result.content[0].text);
  assert.ok(found.items.length >= 1);
  assert.match(found.rendered, /鸽子/);
  engine.close();
});

test('MCP: forget 真删，且写入版本链', async () => {
  const engine = makeEngine();
  const server = createMcpServer(engine);

  await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'mnema_remember',
      arguments: { text: '今天在公园看到一只很胖的鸽子', channelId: 'chat:user:1', participants: ['self', 'user:1'] },
    },
  });
  const memories = engine.memories();
  assert.equal(memories.length, 1);

  const forgotten = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'mnema_forget', arguments: { memoryId: memories[0].id } },
  });
  const result = JSON.parse(forgotten.result.content[0].text);
  assert.equal(result.op, 'forget');
  assert.equal(engine.memories().length, 0);
  assert.equal(engine.versions(memories[0].id).length, 1, '删除应留版本记录');
  engine.close();
});

test('MCP: 未知工具/未知方法返回错误', async () => {
  const engine = makeEngine();
  const server = createMcpServer(engine);

  const badTool = await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } });
  assert.ok(badTool.error);

  const badMethod = await server.handle({ jsonrpc: '2.0', id: 8, method: 'nope' });
  assert.equal(badMethod.error.code, -32601);
  engine.close();
});

test('MCP: 工具定义都有 name/description/inputSchema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.name.startsWith('mnema_'));
    assert.ok(tool.description.length > 4);
    assert.equal(tool.inputSchema.type, 'object');
  }
});
