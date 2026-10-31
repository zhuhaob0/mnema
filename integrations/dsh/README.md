# mnema-supervisor

DSH 部署适配器：把 [mnema](../../) 记忆服务交给 DSH 宿主托管。

> **插件启用 → mnema 启动；插件停用 → mnema 停止。**
> 不再需要开机自启、计划任务或手动开终端。

## 为什么做成插件

mnema 是 DSH 的配套服务（QQ 机器人靠它存记忆）。让它跟着 DSH 的生命周期走，比开机常驻更合理：

| 方式 | 问题 |
|---|---|
| 开机自启（启动文件夹） | DSH 没开时它也在跑，白占内存 |
| 计划任务 | 需要管理员权限 |
| **插件托管** | 跟着 DSH 开关，状态可见、可重启 |

## 机制

```
DSH 启动 → 加载插件 → 检查 8321 端口
                        ├─ 已占用 → 认领外部实例（不重复启动）
                        └─ 空闲   → spawn node src/cli.js serve

DSH 退出 / 插件停用 → taskkill /T 自己的子进程
进程崩溃 → 2s→4s→…→60s 指数退避重启（最多 10 次）
```

开关联动不需要重启 DSH：插件每 2 秒检查 `profile/package.json` 的 `bundles` 列表，
被移除就停服务，被加回就重新拉起（与 `qqbot-supervisor` 同一套做法）。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件页的启用开关 |
| `mnemaDir` | `E:\Code\mnema` | mnema 所在目录 |
| `port` | `8321` | HTTP 端口 |
| `db` | 空 | SQLite 路径，留空用 `%USERPROFILE%\mnema-data\mnema.db` |
| `nodePath` | 空 | node 可执行文件，留空用当前 node |
| `autoStart` | `true` | 插件加载时自动启动 |

## 工具

| 工具 | 作用 |
|---|---|
| `mnema_status` | 查看状态：进程、端口、重启次数、最近日志 |
| `mnema_restart` | 重启 mnema |

## 安装

```powershell
# 1) 链接到 DSH profile
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add link:E:/Code/mnema/integrations/dsh

# 2) 在 package.json 的 dsh.profile.bundles 里加 'mnema-supervisor'

# 3) 重启 DSH
```

## License

MIT
