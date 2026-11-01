# mnema 范围与「类人」讨论纪要

> 2026-11-01 讨论整理。用途：下次接着聊时不用从头复述。

## 1. 现状诊断：mnema 是三层耦合体

| 层 | 代码 | 判断 |
|---|---|---|
| 记忆核心 | `src/core/`：encoder、consolidate、recall、embedding、write-queue、gate、disclosure | ✅ 属于记忆 |
| 身份/社交 | `persona`（可编辑角色卡）、`narrative`（自写只读）、`relationship`（关系度） | ⚠️ 边界模糊 |
| 运维/宿主 | `src/http/console.js`（四个 tab）、`src/mcp/`、`integrations/dsh/`（spawn/重启/bundle 轮询） | ❌ 明确超出 |

## 2. 为什么会这样（演化原因，不是设计失误）

1. QQ 桥接需要「人格注入」，把角色卡放进 mnema 一次 HTTP 全拿（persona + 记忆）
2. DSH 需要服务不挂，supervisor 做进了 `integrations/dsh`
3. 需要看记忆长什么样，就有了 console 的四个 tab

## 3. 代价

- 换产品要重写：`integrations/dsh` 是宿主专属
- 职责混测：记忆正确性 vs 进程生命周期
- 遗忘语义冲突：人格不该遗忘，却和会衰减的记忆同库
- 边界侵蚀：今天 persona，明天群公告/工具配置

## 4. 三条路

| 方案 | 内容 | 成本 |
|---|---|---|
| A | 只做概念分层（文档/目录） | 低 |
| **B（推荐）** | 物理拆分：core 库 / serve / console 可选 / supervisor 独立 | 中 |
| C | 激进：persona 移出 mnema，relationship 只做内部权重 | 高 |

**建议：B 为主，C 只做一半**——persona 数据可留（identity facts），编辑界面移出；supervisor 独立。

## 5. 与 LangMem / TiMem 的异同

| 维度 | mnema | LangMem | TiMem |
|---|---|---|---|
| 结构 | 工作记忆/L1 事件/L2 语义/叙事/人格 | semantic/episodic/procedural，无固定分层 | 时间树 TMT，叶→根抽象到 persona |
| 写入 | 每消息入队，夜间批量巩固 | hot path 工具 或 background manager | 时间窗聚合 + 语义引导跨层整合 |
| 遗忘 | **第一等公民**（衰减+再巩固+关系降温） | 无内建遗忘 | 靠摘要压缩，无遗忘曲线 |
| 关系 | 关系度调制「记多少/说多少」 | namespace 隔离，关系不影响力 | 无多人关系模型 |
| 人格 | persona 可编辑 / narrative 只读 | procedural + prompt 优化 | persona 是树根涌现物 |
| 时间 | 有时间戳，无显式层级 | 基本无 | **时间是第一等组织原则** |

**可借鉴**：TiMem 的时间层级（周/月节点，正好接会话归档）、复杂度自适应召回。
**不要借鉴**：LangMem 的「只增不减」；TiMem 把 persona 当记忆抽象产物（与我们的权力分离冲突）。

## 6. 「真正的人」还缺什么

| 维度 | 现状 | 缺口 |
|---|---|---|
| 情绪 | 事件有情绪标签 | 当前心情、惯性、调节 |
| 驱力 | 无 | 无聊/好奇/孤独等内驱 |
| 主动性 | 纯响应式 | 目标、计划、自发行为 |
| 社会认知 | 关系度是标量 | 人物卡（雷区/喜好/信任/未兑现承诺） |
| 时间感 | 只有时间戳 | 期待、纪念日、等待 |
| 元认知 | 有 feedback 工具 | 置信度校准、从错误学习 |
| 离线思考 | 巩固=摘要压缩 | 反刍、预演、计划生成 |
| 自我 | persona 可编辑 | 自我模型随经历缓慢变化 |

**建议顺序**：①内在状态（mood/energy）→ ②离线反思 → ③人物卡 → ④目标/主动性。

## 7. 开源参考（没有单一「类人模型」库）

- 社会模拟：Generative Agents（反思+计划）、Concordia、OASIS、Sotopia、Humanoid Agents（需求/情绪）
- 记忆身份：Letta、Mem0、LangMem、Zep/Graphiti、mnema
- 技能成长：Voyager（技能库）、Agent Workflow Memory、Reflexion、ExpeL
- 角色人格：SillyTavern、AgnAI
- 理论：CoALA、ACT-R/Soar

结论：抄机制不抄代码。

## 8. 未决清单（下次先定这些）

1. 选 A / B / C？
2. 若 B：supervisor 移去哪个仓库？console 是否独立包？
3. persona 的编辑界面是否挪出 mnema？（数据留、界面走）
4. 关系度是否只对内暴露权重、不暴露 L2 语义？
5. 是否先做「内在状态」这一块（性价比最高）？
6. 时间层级（周/月记忆节点）要不要排期，与会话归档怎么衔接？
