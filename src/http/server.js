/**
 * HTTP API v1（node:http，无框架）
 */

import http from 'node:http';
import { CONSOLE_HTML } from './console.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function authorized(req, url, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim() === token;
  return url.searchParams.get('token') === token;
}

/**
 * @param {ReturnType<import('../engine.js').createEngine>} engine
 */
export function createHttpServer(engine, { token = engine.config.http.token } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/console') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CONSOLE_HTML);
      return;
    }

    if (path === '/' || path === '/v1/health') {
      sendJson(res, 200, {
        ok: true,
        engine: 'mnema',
        schemaVersion: engine.schema.schemaVersion,
        embedding: { kind: engine.embedding.activeKind, degraded: engine.embedding.degraded },
        tenant: engine.config.tenant,
        time: new Date().toISOString(),
      });
      return;
    }

    if (!authorized(req, url, token)) {
      sendJson(res, 401, { ok: false, error: '未授权：请提供 token' });
      return;
    }

    try {
      if (path === '/v1/schema') {
        sendJson(res, 200, { schemaVersion: engine.schema.schemaVersion, expected: engine.schema.expected });
        return;
      }

      if (path === '/v1/stats' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...engine.stats(url.searchParams.get('tenant') ?? undefined) });
        return;
      }

      if (path === '/v1/events' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.channel?.id) {
          sendJson(res, 400, { ok: false, error: 'channel.id 不能为空' });
          return;
        }
        if (!Array.isArray(body.events) || body.events.length === 0) {
          sendJson(res, 400, { ok: false, error: 'events 不能为空' });
          return;
        }
        const result = await engine.ingest({
          tenant: body.tenant ?? engine.config.tenant,
          channel: body.channel,
          events: body.events,
          meta: body.meta ?? {},
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (path === '/v1/recall' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await engine.recall({
          tenant: body.tenant ?? engine.config.tenant,
          channelId: body.channelId,
          participants: body.participants ?? [],
          query: String(body.query ?? ''),
          maxItems: body?.budget?.maxItems,
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (path === '/v1/memories' && req.method === 'GET') {
        const list = engine.memories({
          tenant: url.searchParams.get('tenant') ?? undefined,
          kind: url.searchParams.get('kind') ?? 'all',
          limit: Number(url.searchParams.get('limit') ?? 100),
          offset: Number(url.searchParams.get('offset') ?? 0),
        });
        sendJson(res, 200, { ok: true, memories: list });
        return;
      }

      if (path === '/v1/feedback' && req.method === 'POST') {
        const body = await readJson(req);
        const result = engine.feedback({
          tenant: body.tenant ?? undefined,
          op: body.op,
          memoryId: body.memoryId,
          text: body.text ?? '',
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (path.startsWith('/v1/versions/') && req.method === 'GET') {
        const memoryId = decodeURIComponent(path.slice('/v1/versions/'.length));
        const versions = engine.versions(memoryId, url.searchParams.get('tenant') ?? undefined);
        sendJson(res, 200, { ok: true, versions });
        return;
      }

      if (path === '/v1/consolidate' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await engine.consolidate({
          tenant: body.tenant ?? engine.config.tenant,
          now: body.now ? Number(body.now) : undefined,
        });
        sendJson(res, 200, result);
        return;
      }

      if (path === '/v1/relationships' && req.method === 'GET') {
        const list = engine.relationships(url.searchParams.get('tenant') ?? undefined);
        sendJson(res, 200, { ok: true, relationships: list });
        return;
      }

      if (path.startsWith('/v1/relationships/') && req.method === 'GET') {
        const contactId = decodeURIComponent(path.slice('/v1/relationships/'.length));
        const rel = engine.relationship(contactId, url.searchParams.get('tenant') ?? undefined);
        if (!rel) {
          sendJson(res, 404, { ok: false, error: '未找到该联系人' });
          return;
        }
        sendJson(res, 200, { ok: true, relationship: rel });
        return;
      }

      if (path === '/v1/persona' && req.method === 'GET') {
        const persona = engine.persona(url.searchParams.get('tenant') ?? undefined);
        sendJson(res, 200, { ok: true, persona });
        return;
      }

      if (path === '/v1/persona' && req.method === 'PUT') {
        const body = await readJson(req);
        if (typeof body?.markdown !== 'string') {
          sendJson(res, 400, { ok: false, error: 'markdown 必须是字符串' });
          return;
        }
        const persona = engine.setPersona(body.markdown, body.tenant ?? undefined);
        sendJson(res, 200, { ok: true, persona });
        return;
      }

      if (path === '/v1/narrative' && req.method === 'POST') {
        const body = await readJson(req);
        const narrative = engine.regenerateNarrative({ tenant: body.tenant ?? undefined });
        sendJson(res, 200, { ok: true, narrative });
        return;
      }

      if (path === '/v1/narrative' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, narrative: engine.narrative(url.searchParams.get('tenant') ?? undefined) });
        return;
      }

      sendJson(res, 404, { ok: false, error: `未知路由 ${req.method} ${path}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  return {
    server,
    listen({ host = engine.config.http.host, port = engine.config.http.port } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
