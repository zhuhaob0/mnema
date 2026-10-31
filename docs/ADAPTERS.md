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

---

## 11. 巩固与披露（P2 新增）

### 11.1 触发巩固

```http
POST /v1/consolidate
{ "tenant": "default" }
```

返回：

```json
{ "ok": true, "scanned": 120, "clusters": 18, "factsCreated": 6,
  "factsMerged": 3, "factsSimilar": 2, "decayed": 120, "finishedAt": "..." }
```

- `scanned` — 自上次巩固以来的新事件数（水位由引擎自己记）
- `factsCreated` — 新提炼的事实
- `factsMerged` — 与已有事实合并（相似 ≥0.92）
- `factsSimilar` — 相似但不同（0.75~0.92），按"模式分离"并存
- `decayed` — 被衰减的条目数

服务端默认每天 03:30 自动跑一次（`--at` 或 `MNEMA_CONSOLIDATE_AT` 可改）。
适配器一般不需要主动调用，除非想"立刻整理"。

### 11.2 recall 的披露字段

`/v1/recall` 返回的每个 item 带 `disclosure`：

```json
{
  "id": "ev_...", "text": "他最近工作上有变动", "score": 0.71,
  "disclosure": { "level": 2, "reason": "第三方近况，最多概括", "subjectPresent": false },
  "withheld": false
}
```

| level | 适配器该怎么做 |
|---|---|
| 3 | 正常把 text 拼进提示词 |
| 2 | 拼进去，并附加"只能概括，不要复述原话" |
| 1 | **不要**把 text 拼进去；只给"你知道但不宜细说"的提示 |
| 0 | 完全不出现 |

`rendered` 字段已经按等级处理好了（等级 1 的条目不出现原文，只加一行提示），
直接用 `rendered` 最省事。

### 11.3 性格参数（影响披露）

`PUT /v1/persona` 支持 `traits`：

```json
{ "markdown": "# 性格底色\n- 嘴上毒心里软",
  "traits": { "discretion": 0.6, "gossip": 0.3, "protectiveness": 0.7 } }
```

| 参数 | 0~1 | 作用 |
|---|---|---|
| `discretion` | 越高越谨慎 | 整体压低披露等级 |
| `gossip` | 越高越爱聊 | 非秘密内容 +1 |
| `protectiveness` | 越高越护短 | 替不在场的人保留 → -1 |

`GET /v1/persona` 返回 `{ markdown, traits, updatedAt }`。

### 11.4 单独问"这条能不能说"

引擎内部有 `disclosureFor(memory, audience, tenant)`；
HTTP 侧暂未暴露独立端点（可以在 recall 的 item.disclosure 里拿到同样的判定）。

---

## 12. 叙事接口（P3）

### 12.1 读取

```http
GET /v1/narrative?tenant=default
```

```json
{ "ok": true, "narrative": { "markdown": "# 我的状态（2026-10-30 更新）\n...", "updatedAt": "..." } }
```

只读。没生成过时返回 `{ "narrative": null }`。

### 12.2 触发重写

```http
POST /v1/narrative   { "tenant": "default" }
```

返回新生成的 markdown 与时间。**内容由引擎写，不接受外部传入的正文**——
这是"叙事不可编辑"的接口级保证。

### 12.3 适配器怎么用

- 唤醒时：`recall` 的 `rendered` 已包含叙事，通常不用单独取
- 需要展示"它最近的状态"：直接读 `/v1/narrative`
- 想让它"立刻整理一下心情"：调 `POST /v1/narrative`

---

## 13. 再巩固与浏览（P4 新增）

### 13.1 纠正 / 确认 / 遗忘

```http
POST /v1/feedback
{ "op": "correct", "memoryId": "sem_x1", "text": "他不是跳槽，是被裁了" }
```

| op | 行为 | 返回 |
|---|---|---|
| `correct` | 写新版本，旧版本进版本链，内容替换 | `{ ok, from, to }` |
| `confirm` | 更新确认时间，权重 +0.05 | `{ ok, text }` |
| `forget` | **真删除**（隐私要求），保留一条版本记录 | `{ ok, forgotten }` |

**为什么 forget 要留版本记录**：删掉的是"内容"，但"曾经有过这条记忆"这件事本身要留痕，
否则没法审计"某条信息是否被处理过"。

### 13.2 版本链

```http
GET /v1/versions/sem_x1
```

返回该记忆的历史版本（按时间倒序）。每次 `correct` / `forget` 都会追加一条。

### 13.3 浏览记忆

```http
GET /v1/memories?kind=all|episodic|semantic&limit=100&offset=0
```

用于控制台/调试。返回条目带 `kind`（`episodic` 事件 / `semantic` 事实）。

### 13.4 控制台

浏览器打开 `http://127.0.0.1:8321/console?token=<你的 token>`：

| 页签 | 内容 |
|---|---|
| 记忆 | 事件与事实列表，本地关键词过滤 |
| 关系 | 联系人等级、分数、信号明细 |
| 叙事 | 只读展示 |
| 性格 | 可编辑并保存 |

页面本身不需要 token（本地 HTML），但数据接口需要；token 会存进 localStorage。

### 13.5 MCP 工具（形态 C，已实现）

零依赖的 stdio JSON-RPC 实现，客户端配置：

```json
{ "command": "node", "args": ["E:/Code/mnema/src/mcp/cli.js"],
  "env": { "MNEMA_DB": "E:/Code/mnema/data/mnema.db" } }
```

暴露 7 个工具：`mnema_remember` / `mnema_recall` / `mnema_relationships` /
`mnema_narrative` / `mnema_persona` / `mnema_forget` / `mnema_stats`。

> 说明：MCP 部分**没有引入 SDK 依赖**，按协议手写了 `initialize` / `tools/list` / `tools/call`。
> 好处是零依赖、可直接审阅；若将来协议有变，换 SDK 只需替换 `src/mcp/server.js` 的 transport 层。

---

## 14. 批量导入（迁移专用）

```http
POST /v1/import
{ "tenant": "default",
  "events": [ { "text": "…", "at": "…", "participants": ["self","user:1"],
                "contentClass": "status", "sensitivity": "contact" } ],
  "facts":  [ { "text": "…", "participants": ["self","user:1"],
                "contentClass": "preference", "sensitivity": "contact" } ],
  "interactions": [ { "contactId": "user:1", "at": "…", "chars": 20, "emotion": "anxiety" } ] }
```

返回：

```json
{ "ok": true, "importedEvents": 2, "importedFacts": 1,
  "importedInteractions": 20, "contacts": 1 }
```

**行为**：

- 跳过编码器与门控，`contentClass` / `sensitivity` / `subject` **按传入值原样落库**
- 只要求 `text` 非空；其余字段有默认值
- 导入后自动重算涉及联系人的关系度
- 用于 v1 → v2 迁移等**受信场景**

**安全**：与其它接口共用 token 鉴权。它绕过门控，所以只应在迁移时开启；
生产环境建议导入完立即停用（或加环境变量开关）。
