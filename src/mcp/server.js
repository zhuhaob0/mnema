/**
 * MCP server（stdio，JSON-RPC 2.0，零依赖）
 *
 * 让任何 MCP 客户端（Claude Desktop / DSH / Cursor…）零代码接入记忆。
 * 协议要点：newline-delimited JSON；initialize → tools/list → tools/call。
 */

import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

function text(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

function toolResultError(message) {
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
}

const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  {
    name: 'mnema_remember',
    description: '记住一件事（手动写入）。适合"记住：……"这类明确要求。',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('要记住的内容'),
        channelId: str('会话标识，例如 chat:user:1'),
        participants: { type: 'array', items: { type: 'string' }, description: '参与者，第一个当作"对方"' },
        kind: { type: 'string', enum: ['direct', 'public'], description: '会话类型，默认 direct' },
      },
      required: ['text', 'channelId', 'participants'],
    },
    async run(engine, args) {
      const result = await engine.ingest({
        channel: { id: args.channelId, kind: args.kind ?? 'direct', participants: args.participants },
        events: [{ role: 'user', text: args.text }],
      });
      return text(result);
    },
  },
  {
    name: 'mnema_recall',
    description: '按问题检索记忆，返回结构化条目与可直接拼进提示词的文本。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('要检索的问题/线索'),
        channelId: str('会话标识'),
        participants: { type: 'array', items: { type: 'string' }, description: '当前会话参与者' },
        maxItems: { type: 'number', description: '最多返回几条，默认 10' },
      },
      required: ['query', 'channelId', 'participants'],
    },
    async run(engine, args) {
      const result = await engine.recall({
        query: args.query,
        channelId: args.channelId,
        participants: args.participants,
        maxItems: args.maxItems,
      });
      return text(result);
    },
  },
  {
    name: 'mnema_relationships',
    description: '查看联系人的关系度（等级、分数、信号明细）。',
    inputSchema: {
      type: 'object',
      properties: { contactId: str('可选：只看某个联系人') },
    },
    run(engine, args) {
      if (args.contactId) {
        const rel = engine.relationship(args.contactId);
        return text(rel ?? { ok: false, error: '未找到该联系人' });
      }
      return text(engine.relationships());
    },
  },
  {
    name: 'mnema_narrative',
    description: '读取"我是谁、最近在经历什么"的叙事自我（只读）。',
    inputSchema: { type: 'object', properties: {} },
    run(engine) {
      return text(engine.narrative() ?? { ok: false, error: '还没生成叙事，先跑一次巩固' });
    },
  },
  {
    name: 'mnema_persona',
    description: '读取性格底色（owner 可写，其他人只读）。',
    inputSchema: { type: 'object', properties: {} },
    run(engine) {
      return text(engine.persona() ?? { ok: false, error: '还没设置性格' });
    },
  },
  {
    name: 'mnema_forget',
    description: '忘掉一条记忆（隐私要求时使用，真删除）。',
    inputSchema: {
      type: 'object',
      properties: { memoryId: str('要删除的记忆 id') },
      required: ['memoryId'],
    },
    run(engine, args) {
      return text(engine.feedback({ op: 'forget', memoryId: args.memoryId }));
    },
  },
  {
    name: 'mnema_stats',
    description: '记忆统计：事件数、事实数、关系数、存储情况。',
    inputSchema: { type: 'object', properties: {} },
    run(engine) {
      return text(engine.stats());
    },
  },
];

export function createMcpServer(engine, { name = 'mnema', version = '0.1.0' } = {}) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  async function handle(message) {
    const { id, method, params } = message ?? {};
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };
    }
    if (method === 'tools/call') {
      const tool = byName.get(params?.name);
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具 ${params?.name}` } };
      }
      try {
        const result = await tool.run(engine, params?.arguments ?? {});
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: toolResultError(error?.message ?? String(error)) };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } };
  }

  function start({ input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } })}\n`);
        return;
      }
      const response = await handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    return rl;
  }

  return { handle, start, tools: TOOLS };
}
