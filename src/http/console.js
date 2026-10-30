/**
 * 控制台（单文件页面）：记忆浏览 / 关系 / 叙事 / 性格
 * 仅本地使用；token 从 URL 或 localStorage 读取。
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mnema · 记忆控制台</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --muted:#8b93a7; --accent:#6ea8fe; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,"Segoe UI",sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .tag { color:var(--muted); font-size:12px; }
  nav { display:flex; gap:8px; padding:12px 20px; border-bottom:1px solid var(--line); }
  nav button { background:transparent; color:var(--muted); border:1px solid transparent; padding:6px 12px; border-radius:8px; cursor:pointer; }
  nav button.on { color:var(--text); background:var(--panel); border-color:var(--line); }
  main { padding:20px; max-width:1100px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .panel h2 { font-size:14px; margin:0 0 12px; color:var(--muted); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  .muted { color:var(--muted); }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; background:#1f2530; font-size:12px; color:var(--muted); }
  textarea { width:100%; min-height:180px; background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px; font:13px/1.6 ui-monospace,monospace; }
  input[type=text] { background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; width:280px; }
  button.act { background:#243044; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; }
  button.act:hover { border-color:var(--accent); }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  pre { white-space:pre-wrap; margin:0; font:13px/1.7 ui-monospace,monospace; }
</style>
</head>
<body>
<header>
  <h1>mnema</h1>
  <span class="tag" id="tag">loading…</span>
</header>
<nav>
  <button data-tab="mem" class="on">记忆</button>
  <button data-tab="rel">关系</button>
  <button data-tab="nar">叙事</button>
  <button data-tab="persona">性格</button>
</nav>
<main>
  <section id="tab-mem">
    <div class="panel">
      <h2>记忆</h2>
      <div class="row">
        <input type="text" id="q" placeholder="按关键词过滤（本地过滤）">
        <button class="act" id="reload">刷新</button>
        <span class="muted" id="memCount"></span>
      </div>
      <table><thead><tr><th>时间</th><th>类型</th><th>内容</th><th>权重</th><th>敏感度</th></tr></thead>
      <tbody id="memBody"></tbody></table>
    </div>
  </section>

  <section id="tab-rel" hidden>
    <div class="panel">
      <h2>关系度</h2>
      <table><thead><tr><th>联系人</th><th>等级</th><th>分数</th><th>最后互动</th><th>信号</th></tr></thead>
      <tbody id="relBody"></tbody></table>
    </div>
  </section>

  <section id="tab-nar" hidden>
    <div class="panel">
      <h2>叙事自我（只读）</h2>
      <pre id="narText" class="muted">（还没生成）</pre>
    </div>
  </section>

  <section id="tab-persona" hidden>
    <div class="panel">
      <h2>性格底色（可编辑）</h2>
      <textarea id="personaText" placeholder="# 性格底色\n- 嘴上毒，心里软"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="act" id="savePersona">保存</button>
        <span class="muted" id="personaMsg"></span>
      </div>
    </div>
  </section>
</main>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('mnema_token') || '';
if (token) localStorage.setItem('mnema_token', token);
const auth = token ? { authorization: 'Bearer ' + token } : {};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...auth, ...(opts.headers || {}) } });
  return res.json();
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let allMemories = [];

async function loadStats() {
  const data = await api('/v1/health');
  const stats = await api('/v1/stats');
  document.getElementById('tag').textContent =
    \`schema v\${data.schemaVersion} · 事件 \${stats.events ?? 0} · 事实 \${stats.facts ?? 0} · 关系 \${stats.relationships ?? 0}\`;
}

async function loadMemories() {
  const data = await api('/v1/memories?limit=200');
  allMemories = data.memories || [];
  renderMemories();
}

function renderMemories() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const list = q ? allMemories.filter((m) => (m.gist ?? m.text ?? '').toLowerCase().includes(q)) : allMemories;
  document.getElementById('memCount').textContent = \`\${list.length}/\${allMemories.length} 条\`;
  document.getElementById('memBody').innerHTML = list.map((m) => \`
    <tr>
      <td class="muted">\${esc((m.at ?? m.lastConfirmedAt ?? '').slice(0, 16))}</td>
      <td><span class="chip">\${m.kind === 'semantic' ? '事实' : '事件'}</span></td>
      <td>\${esc(m.gist ?? m.text)}</td>
      <td class="muted">\${Number(m.weight ?? 0).toFixed(2)}</td>
      <td class="muted">\${esc(m.sensitivity)}</td>
    </tr>\`).join('') || '<tr><td colspan="5" class="muted">没有记忆</td></tr>';
}

async function loadRelationships() {
  const data = await api('/v1/relationships');
  const rows = data.relationships || [];
  document.getElementById('relBody').innerHTML = rows.map((r) => \`
    <tr>
      <td>\${esc(r.contactId)}</td>
      <td><span class="chip">\${esc(r.tier)}</span></td>
      <td>\${Number(r.score ?? 0).toFixed(2)}</td>
      <td class="muted">\${esc((r.lastInteract ?? '').slice(0, 10))}</td>
      <td class="muted">\${esc(JSON.stringify(r.signals ?? {}))}</td>
    </tr>\`).join('') || '<tr><td colspan="5" class="muted">还没有关系记录</td></tr>';
}

async function loadNarrative() {
  const data = await api('/v1/narrative');
  document.getElementById('narText').textContent = data.narrative?.markdown || '（还没生成，跑一次巩固试试）';
}

async function loadPersona() {
  const data = await api('/v1/persona');
  document.getElementById('personaText').value = data.persona?.markdown || '';
}

document.getElementById('savePersona').addEventListener('click', async () => {
  const markdown = document.getElementById('personaText').value;
  const res = await api('/v1/persona', { method: 'PUT', body: JSON.stringify({ markdown }) });
  document.getElementById('personaMsg').textContent = res.ok ? '已保存' : ('失败：' + (res.error || ''));
});

document.getElementById('reload').addEventListener('click', loadMemories);
document.getElementById('q').addEventListener('input', renderMemories);

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b === btn));
    for (const name of ['mem', 'rel', 'nar', 'persona']) {
      document.getElementById('tab-' + name).hidden = name !== btn.dataset.tab;
    }
    if (btn.dataset.tab === 'rel') loadRelationships();
    if (btn.dataset.tab === 'nar') loadNarrative();
    if (btn.dataset.tab === 'persona') loadPersona();
  });
});

loadStats(); loadMemories();
</script>
</body>
</html>`;
