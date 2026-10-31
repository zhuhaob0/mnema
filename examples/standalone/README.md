# 最小接入示例（standalone）

**不依赖 DSH、不依赖任何 agent 框架**，只用 HTTP 调 mnema 的 API —— 用来证明「mnema 是通用记忆引擎」。

同一份演示有两个实现，行为完全一致：

| 文件 | 语言 | 依赖 |
|---|---|---|
| `demo.mjs` | Node.js | 无（用内置 `fetch`） |
| `demo.py` | Python 3.8+ | 无（只用标准库 `urllib`） |

## 跑起来

```bash
# 1) 启动服务（用独立的 demo 库，不碰你的真实记忆）
node src/cli.js serve --port 8321 --db ./data/demo.db

# 2) 另开一个终端跑示例（二选一）
node examples/standalone/demo.mjs
python examples/standalone/demo.py
```

真实输出：

```
✓ mnema mnema schema v5（embedding: http）
✓ 写入事件 4 条（编码 3，跳过 1）

— 巩固前召回（候选 3，返回 3）—
  [episodic] 我每天早上喝手冲咖啡，不加糖  score=0.46  披露=L3
  [episodic] 我每天早上都要喝一杯手冲咖啡，不加糖  score=0.44  披露=L3
  [episodic] 早上起来要喝一杯手冲咖啡，不加糖  score=0.42  披露=L3

✓ 巩固完成：扫描 3 条，新建事实 1，合并 0

— 巩固后召回（候选 4，返回 4）—
  [semantic] 我每天早上喝手冲咖啡，不加糖  score=0.52
  [episodic] 我每天早上喝手冲咖啡，不加糖  score=0.41
  …
```

注意 `[semantic]` 那条：**巩固把三条经历抽象成了一条事实**，这就是「记忆从经历变成知识」。

## 演示了什么

| 步骤 | 接口 | 说明 |
|---|---|---|
| 探活 | `GET /v1/health` | 引擎/schema/embedding 状态 |
| 写事件 | `POST /v1/events` | 对话原文进 `episodic` 层，自动编码、门控（「跳过 1」是被判为低显著度的提问） |
| 召回 | `POST /v1/recall` | 按 query + 参与者 + 关系度排序，带 `score` 与披露等级 |
| 巩固 | `POST /v1/consolidate` | 仿睡眠：聚类 → 抽象出 `semantic` 事实 |
| 再召回 | `POST /v1/recall` | 抽象事实也能被召回 |

## 换成你的 agent

把这两步放进你自己的循环即可：

```js
// 每轮对话结束：写入
await fetch(`${BASE}/v1/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenant: 'my-agent',
    channel: { id: sessionId, participants: [userId] },
    events: [{ role: 'user', text }],
  }),
});

// 下一轮开始前：召回，把 rendered 拼进 system prompt
const { rendered } = await (await fetch(`${BASE}/v1/recall`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenant: 'my-agent', channelId: sessionId, participants: [userId], query: userText }),
})).json();
```

`rendered` 是已经排好序、按披露等级裁剪过的文本块，直接塞进提示词即可。

Python 版同样只是两段 HTTP 调用（完整版见 `demo.py`）：

```python
import json, urllib.request

def post(path, payload):
    req = urllib.request.Request(
        f"http://127.0.0.1:8321{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

post("/v1/events", {"tenant": "my-agent", "channel": {"id": session_id, "participants": [user_id]}, "events": [{"role": "user", "text": text}]})
rendered = post("/v1/recall", {"tenant": "my-agent", "channelId": session_id, "participants": [user_id], "query": user_text})["rendered"]
```

> Windows 老终端（GBK）下 `demo.py` 已自动把输出切到 UTF-8；若仍乱码，先执行 `chcp 65001`。

## 可选配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MNEMA_URL` | `http://127.0.0.1:8321` | 服务地址 |
| `MNEMA_TOKEN` | 空 | 服务端开启鉴权时填（`Authorization: Bearer`） |

## 注意

- `--db ./data/demo.db` 会生成独立演示库，不污染真实记忆；删掉即可重置
- 时间戳用「相对现在」（`daysAgo(2)` 等），否则旧时间会被衰减，召回和巩固都看不出效果
- 巩固靠 embedding 聚类：三条说法要**足够相近**才会抽象成事实（示例里就是这么写的）
- 离线 hash embedding 也能跑，只是语义相似度会弱一些
