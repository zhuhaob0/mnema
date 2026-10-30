# 接入规范（Adapter Contract）

> `mnema` 与应用解耦：它只管"记忆怎么存、怎么忘、怎么想起来"，
> 不关心消息从哪来（QQ / 微信 / 邮件 / 客服工单 / 桌面助手）。
> 应用侧写一个**适配器（Adapter）**，负责把交互翻译成 Event，把检索结果翻译成提示词。

---

## 1. 三种接入形态

| 形态 | 适用 | 特点 |
|---|---|---|
| **A. 嵌入式 SDK** | 与引擎同进程（Node / Python） | 零网络开销，最紧耦合 |
| **B. 本地 HTTP 服务** | 跨进程、跨语言 | 默认形态；127.0.0.1 + 可选 token |
| **C. MCP server** | 任何 MCP 客户端（Claude Desktop / DSH / Cursor…） | 把记忆暴露成工具，零代码接入 |

三种形态共享同一套语义与存储，**可以混用**（例如宿主用 HTTP，同时开 MCP 给别的 agent 用）。

---

## 2. REST API（v1）

所有路径前缀 `/v1`。默认监听 `127.0.0.1:8321`，可用 `Authorization: Bearer <token>`。

### 2.1 提交交互事件

```http
POST /v1/events
Content-Type: application/json

{
  "tenant": "default",
  "channel": { "id": "chat:user:197196327", "kind": "direct", "participants": ["user:197196327"] },
  "events": [
    { "role": "user", "text": "我最近在考虑跳槽", "at": "2026-10-30T21:12:00+08:00" },
    { "role": "assistant", "text": "怕不稳？", "at": "2026-10-30T21:12:10+08:00" }
  ],
  "meta": { "source": "qq-bridge", "turnId": "t-42" }
}
```

返回：

```json
{ "accepted": 2, "encoded": 1, "skipped": 1, "reason": "低显著度（寒暄）", "eventIds": ["ev_..."] }
```

- `encoded` — 通过门控并写入索引的条数
- `skipped` — 被门控拦掉的条数（会返回原因，便于调参）
- 适配器可一次性提交一批，适合"每轮对话结束"或"每 N 分钟"

### 2.2 检索（唤醒）

```http
POST /v1/recall

{
  "tenant": "default",
  "channelId": "chat:user:197196327",
  "query": "你还记得我上次说的跳槽吗",
  "budget": { "maxItems": 10, "maxTokens": 800 }
}
```

返回：

```json
{
  "items": [
    { "id": "sem_x1", "kind": "semantic", "text": "他打算跳槽，但担心稳定性",
      "score": 0.82, "at": "2026-10-30", "sensitivity": "contact" }
  ],
  "rendered": "【你记得的】\n- 他打算跳槽，但担心稳定性（10 月 30 日）",
  "stats": { "candidates": 240, "returned": 3, "tookMs": 7 }
}
```

- `items` — 结构化结果（适配器可自己排版）
- `rendered` — 引擎按"回忆口吻"拼好的文本（可直接塞提示词）
- 引擎默认**先过滤再打分**：`sensitivity` 不匹配当前 Channel 的直接排除

### 2.3 手动触发巩固

```http
POST /v1/consolidate   { "tenant": "default", "reason": "manual" }
```

返回巩固统计（合并/新建/衰减/叙事更新条数）。夜间调度由引擎自己跑，这个接口用于调试与"立刻整理"。

### 2.4 人格（性格）

```http
GET  /v1/persona?tenant=default
PUT  /v1/persona        { "tenant": "default", "markdown": "# 性格底色\n- ..." }
```

- 只有 **owner** 能写；适配器可读（用于拼提示词）
- 与叙事分开：改性格是"调人格"，不改经历

### 2.5 叙事（自我叙述）

```http
GET /v1/narrative?tenant=default
```

**只读**。由 Actor 在巩固时重写。

### 2.6 关系度

```http
GET /v1/relationships?tenant=default
GET /v1/relationships/:contactId
```

返回等级、分数、信号明细、历史曲线。适配器可用于：
- 决定是否愿意主动找人说话（关系越高越主动）
- 展示"你和我"的关系状态（有些产品喜欢这个）

### 2.7 反馈 / 再巩固

```http
POST /v1/feedback
{
  "tenant": "default",
  "op": "correct" | "confirm" | "forget",
  "memoryId": "sem_x1",
  "text": "他不是跳槽，是被裁了"        // op=correct 时
}
```

- `correct` — 写新版本，旧版本进 `versions`（记忆改写）
- `confirm` — `lastConfirmedAt` 更新，weight 上调
- `forget` — 隐私删除（真删，用于"请忘掉这件事"）

### 2.8 运维

| 接口 | 用途 |
|---|---|
| `GET /v1/health` | 存活 + embedding 服务状态 |
| `GET /v1/stats` | 事件数、事实数、关系数、存储大小、最近巩固时间 |
| `GET /v1/schema` | schemaVersion，供适配器做兼容判断 |

---

## 3. 身份规范

`contactId` 建议用 `type:id`（类型 + 标识），保证跨应用稳定：

| 类型 | 示例 |
|---|---|
| `user` | `user:197196327` |
| `group` | `group:636960140` |
| `email` | `email:a@b.com` |
| `system` | `system:console` |

**Channel** 有两种：

- `direct` — 一对一（参与者 2 人）
- `public` — 多人（触发第 4.2 节的"公共场景规则"）

---

## 4. 关系信号：谁来提供

引擎两种都支持：

| 模式 | 说明 | 适用 |
|---|---|---|
| **推导模式**（默认） | 引擎从 Event 流里自己算（频率、长度、是否主动发起、时间跨度） | 适配器零负担 |
| **上报模式** | 适配器额外提交信号（如"对方主动找你 3 次"） | 宿主有更准的信号时 |

上报接口：

```http
POST /v1/signals

{ "tenant": "default", "contactId": "user:197196327",
  "signals": { "initiatedByThem": 3, "avgMessageLen": 42, "sharedSecret": true } }
```

---

## 5. 扩展点（插件接口）

引擎内部按接口写，默认实现可替换：

| 扩展点 | 默认 | 替换场景 |
|---|---|---|
| `Encoder` | 调 LLM 输出结构化 JSON（提示词内置） | 想换模型/换提示词/用本地小模型 |
| `EmbeddingProvider` | 本地 ONNX（bge-small-zh） | 换 OpenAI 兼容 API、换更大模型 |
| `RelationshipScorer` | 六信号加权 | 产品想要不同的"亲密度"定义 |
| `DecayPolicy` | 指数衰减 + 关系倍数 | 想要线性/阶梯式遗忘 |
| `RetrievalStrategy` | 四路召回 + 融合打分 | 想要 MMR 去重、想要纯向量 |
| `Storage` | SQLite | 多实例部署换 Postgres |
| `Transport` | HTTP + stdio MCP | 需要 gRPC / 消息队列 |
| `Clock` | 系统时间 | 测试用假时钟（巩固/衰减可测） |

**配置即插拔**（`mnema.config.json`）：

```jsonc
{
  "storage": { "kind": "sqlite", "path": "./data/mnema.db" },
  "embedding": { "kind": "local-onnx", "model": "bge-small-zh-v1.5", "dim": 512 },
  "encoder": { "kind": "llm", "provider": "openai-compatible", "baseUrl": "...", "model": "..." },
  "decay": { "halfLife": { "topic": 3, "event": 30, "fact": 365 }, "floor": 0.15 },
  "consolidation": { "at": "03:30", "minNewEvents": 200 }
}
```

---

## 6. 多租户与权限

| 角色 | 权限 |
|---|---|
| **owner** | 读写人格、读全部记忆、删除记忆、改配置 |
| **adapter** | 只能写自己 Channel 的事件、只能检索与自己 Channel 相关的记忆 |
| **guest**（可选） | 只读的关系度/叙事摘要 |

一个进程可服务多个 Tenant（多个 Actor），存储按 `tenant` 分区，**默认互相不可见**。

---

## 7. 版本与兼容

- `GET /v1/schema` 返回 `{ "schemaVersion": 3, "engineVersion": "0.1.0" }`
- 适配器启动时检查 `schemaVersion`，不兼容则拒绝写入
- 引擎自带迁移器（`migrations/`），升级时自动跑，**只前进不回退**
- API 版本走路径（`/v1`），破坏性变更升 `/v2`

---

## 8. MCP 工具（形态 C）

零代码接入任何 MCP 客户端：

| 工具 | 作用 |
|---|---|
| `mnema_remember` | 手动写入一条记忆（"记住：…"） |
| `mnema_recall` | 按问题检索记忆 |
| `mnema_relationships` | 查联系人关系度 |
| `mnema_narrative` | 读叙事自我 |
| `mnema_persona` | 读性格（写仅 owner） |
| `mnema_forget` | 删除一条记忆（隐私） |
| `mnema_stats` | 记忆统计 |

---

## 9. 参考适配器：QQ Bridge

映射关系（供后续重写 QQ Bridge 时参考）：

| QQ 概念 | mnema 概念 |
|---|---|
| 私聊 `private:123` | Channel `{kind:"direct", participants:["user:123"]}` |
| 群聊 `group:456` | Channel `{kind:"public", participants:["group:456"]}` |
| 发言人 QQ 号 | Contact `user:<uin>` |
| 群 | Contact `group:<gid>` |
| ownerQQ | Principal（owner 权限） |
| 唤醒 | 调用 `/v1/recall`，把 `rendered` 拼进提示词 |
| 一轮对话结束 | 批量 `POST /v1/events` |
| 发说说 / 传话 | 视为 Actor 自己的 `action` 事件（写进自传体） |

**QQ Bridge 重写时要做的事**：

1. 保留它现有的协议层（SnowLuma 对接、消息编辑、频率控制）
2. 用 `mnema` 替换 `social-v2.json` 里那套 `activeTopics/pendingThoughts/memberImpressions`
3. 唤醒提示词里的记忆段落改为 `/v1/recall` 的 `rendered`
4. 角色卡 `persona.md` 移到 mnema 的 persona 接口（性格可编辑）
5. 叙事从 mnema 只读（不再人工写）

---

## 10. 接入 checklist

- [ ] 定义 contactId 规范（`type:id`）
- [ ] 区分 direct / public channel（公共场景规则不同）
- [ ] 决定由谁提供关系信号（推导 or 上报）
- [ ] 每轮结束提交 events（或批量）
- [ ] 唤醒时调 recall，用 `rendered` 或 `items` 拼提示词
- [ ] 人格走 persona 接口（可编辑）
- [ ] 叙事只读展示（不参与编辑）
- [ ] 隐私删除走 `/v1/feedback op=forget`
- [ ] 启动检查 `/v1/schema` 的 schemaVersion
