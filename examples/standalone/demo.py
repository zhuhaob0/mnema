#!/usr/bin/env python3
"""
mnema 最小接入示例（Python 版，只用标准库）

和 demo.mjs 演示同一件事，证明接入与语言无关：
  1. 写入对话事件   POST /v1/events
  2. 按上下文召回   POST /v1/recall
  3. 巩固后再次召回  POST /v1/consolidate + /v1/recall

运行：
  1) 先启动服务：node src/cli.js serve --port 8321 --db ./data/demo.db
  2) python examples/standalone/demo.py

环境变量：
  MNEMA_URL    服务地址，默认 http://127.0.0.1:8321
  MNEMA_TOKEN  服务端开了鉴权时填
"""

import datetime
import json
import os
import sys
import urllib.error
import urllib.request

# Windows 老终端默认 GBK，中文/符号可能报 UnicodeEncodeError；统一按 UTF-8 输出
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

BASE = os.environ.get("MNEMA_URL", "http://127.0.0.1:8321")
TOKEN = os.environ.get("MNEMA_TOKEN", "")
TENANT = "demo"
CHANNEL = {"id": "demo-room", "kind": "direct", "participants": ["alice", "bob"]}


def _headers():
    headers = {"content-type": "application/json"}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"
    return headers


def get(path):
    request = urllib.request.Request(f"{BASE}{path}", headers=_headers())
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def post(path, payload=None):
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(f"{BASE}{path}", data=data, method="POST", headers=_headers())
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def days_ago(days):
    """相对现在的时间戳：固定日期会被衰减到权重 0，召回和巩固都看不出效果。"""
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    # 0. 探活
    health = get("/v1/health")
    embedding = (health.get("embedding") or {}).get("kind", "?")
    print(f"[ok] mnema {health.get('engine')} schema v{health.get('schemaVersion')}（embedding: {embedding}）")

    # 1. 写入三天的对话事件（三条说法相近，巩固时才会聚类成事实）
    events = [
        {"role": "user", "text": "我每天早上都要喝一杯手冲咖啡，不加糖", "at": days_ago(2)},
        {"role": "assistant", "text": "那你是喜欢偏酸还是偏苦的豆子？", "at": days_ago(2)},
        {"role": "user", "text": "我每天早上喝手冲咖啡，不加糖", "at": days_ago(1)},
        {"role": "user", "text": "早上起来要喝一杯手冲咖啡，不加糖", "at": days_ago(0)},
    ]
    ingested = post("/v1/events", {"tenant": TENANT, "channel": CHANNEL, "events": events})
    print(f"[ok] 写入事件 {len(events)} 条（编码 {ingested.get('encoded', '?')}，跳过 {ingested.get('skipped', 0)}）")

    # 2. 直接召回
    first = post(
        "/v1/recall",
        {
            "tenant": TENANT,
            "channelId": CHANNEL["id"],
            "participants": CHANNEL["participants"],
            "query": "我喜欢喝什么咖啡",
            "budget": {"maxItems": 5},
        },
    )
    stats = first.get("stats") or {}
    print(f"\n- 巩固前召回（候选 {stats.get('candidates', '?')}，返回 {stats.get('returned', '?')}）-")
    for item in first.get("items", []):
        level = (item.get("disclosure") or {}).get("level", "?")
        text = str(item.get("text", ""))[:40]
        score = float(item.get("score") or 0)
        print(f"  [{item.get('kind')}] {text}  score={score:.2f}  披露=L{level}")

    # 3. 巩固（仿睡眠：事件聚类 → 抽象事实）
    consolidated = post("/v1/consolidate", {"tenant": TENANT})
    print(
        f"\n[ok] 巩固完成：扫描 {consolidated.get('scanned', '?')} 条，"
        f"新建事实 {consolidated.get('factsCreated', 0)}，合并 {consolidated.get('factsMerged', 0)}"
    )

    # 4. 巩固后再召回：应出现抽象出的 semantic 事实
    second = post(
        "/v1/recall",
        {
            "tenant": TENANT,
            "channelId": CHANNEL["id"],
            "participants": CHANNEL["participants"],
            "query": "他的咖啡偏好",
            "budget": {"maxItems": 5},
        },
    )
    stats2 = second.get("stats") or {}
    print(f"\n- 巩固后召回（候选 {stats2.get('candidates', '?')}，返回 {stats2.get('returned', '?')}）-")
    for item in second.get("items", []):
        text = str(item.get("text", ""))[:40]
        score = float(item.get("score") or 0)
        print(f"  [{item.get('kind')}] {text}  score={score:.2f}")

    print("\n完成。核心只有 HTTP：换成任何语言/框架，接法完全一样。")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f"\n[x] 失败：HTTP {error.code} {error.read().decode('utf-8', 'ignore')}")
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"\n[x] 连不上 mnema：{error.reason}")
        print("  请先启动服务：node src/cli.js serve --port 8321 --db ./data/demo.db")
        raise SystemExit(1)
