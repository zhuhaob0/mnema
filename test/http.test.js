import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';
import { createHttpServer } from '../src/http/server.js';

async function withServer(run, { token = '' } = {}) {
  const engine = createEngine({
    dbPath: ':memory:',
    config: { tenant: 't1', http: { token }, embedding: { kind: 'hash', dim: 32 } },
  });
  const http = createHttpServer(engine);
  const addr = await http.listen({ port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await run({ engine, base, token });
  } finally {
    await http.close();
    engine.close();
  }
}

const post = (url, body, token) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('GET /v1/health 返回引擎状态', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.engine, 'mnema');
    assert.ok(data.schemaVersion >= 1);
  });
});

test('POST /v1/events → POST /v1/recall 闭环', async () => {
  await withServer(async ({ base }) => {
    const ingest = await post(`${base}/v1/events`, {
      channel: { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] },
      events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子，还拍了照' }],
    });
    assert.equal(ingest.status, 200);
    const ingested = await ingest.json();
    assert.equal(ingested.ok, true);
    assert.equal(ingested.encoded, 1);

    const recall = await post(`${base}/v1/recall`, {
      channelId: 'chat:user:1',
      participants: ['self', 'user:1'],
      query: '鸽子',
    });
    assert.equal(recall.status, 200);
    const recalled = await recall.json();
    assert.equal(recalled.ok, true);
    assert.ok(recalled.items.length >= 1);
    assert.match(recalled.rendered, /鸽子/);
  });
});

test('缺少 channel.id 时返回 400', async () => {
  await withServer(async ({ base }) => {
    const res = await post(`${base}/v1/events`, { events: [{ text: 'hi' }] });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /channel\.id/);
  });
});

test('配置 token 后未授权返回 401，带 token 可用', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/v1/stats`);
    assert.equal(denied.status, 401);
    const ok = await fetch(`${base}/v1/stats`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(ok.status, 200);
    const okQuery = await fetch(`${base}/v1/stats?token=s3cret`);
    assert.equal(okQuery.status, 200);
  }, { token: 's3cret' });
});

test('persona 读写、relationships 可查', async () => {
  await withServer(async ({ base }) => {
    const put = await fetch(`${base}/v1/persona`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# 性格\n- 嘴硬' }),
    });
    assert.equal(put.status, 200);

    const get = await fetch(`${base}/v1/persona`);
    const persona = await get.json();
    assert.match(persona.persona.markdown, /嘴硬/);

    await post(`${base}/v1/events`, {
      channel: { id: 'chat:user:1', kind: 'direct', participants: ['self', 'user:1'] },
      events: [{ role: 'user', text: '今天在公园看到一只很胖的鸽子' }],
    });
    const rels = await (await fetch(`${base}/v1/relationships`)).json();
    assert.equal(rels.ok, true);
    assert.ok(rels.relationships.length >= 1);
  });
});

test('未知路由返回 404', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
  });
});
