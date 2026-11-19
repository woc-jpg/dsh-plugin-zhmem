// Front end. Deliberately plain: no framework, no build step. A user who
// downloads the zip gets a working window without running npm install, and the
// file stays readable for anyone who wants to change it.

const $ = (id) => document.getElementById(id);

let offline = false;

async function api(name, body = {}) {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '请求失败');
  return data.result;
}

/** Very small markdown renderer: headings, bullets, links, images, bold, code. */
function render(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out = [];
  let list = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } continue; }
    if (t.startsWith('### ')) {
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      out.push(`<h3>${inline(t.slice(4))}</h3>`);
    } else if (/^[-*]\s+/.test(t)) {
      list = list || [];
      list.push(`<li>${inline(t.slice(2))}</li>`);
    } else {
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

// ---- 检索 ----------------------------------------------------------------

async function ask() {
  const query = $('q').value.trim();
  if (!query) return;
  const box = $('answer');
  box.classList.remove('empty');
  box.innerHTML = '<p class="muted">检索中…</p>';
  $('go').disabled = true;
  try {
    const r = await api('zhmem_ask', { query, web_mode: offline ? 'never' : 'auto', images: !offline });
    const badge = r.used_web
      ? '<span class="badge">已联网补充</span>'
      : '<span class="badge">本地命中</span>';
    box.innerHTML = badge + render(r.markdown);
  } catch (error) {
    box.innerHTML = `<p class="muted">出错了：${error.message}</p>`;
  } finally {
    $('go').disabled = false;
  }
}

// ---- 记忆 ----------------------------------------------------------------

async function loadMemories() {
  const box = $('mem-list');
  try {
    const r = await api('zhmem_list_memories', { limit: 50 });
    if (!r.count) { box.innerHTML = '<p class="muted">还没有存过任何记忆。</p>'; return; }
    box.innerHTML = r.markdown
      .split('\n')
      .filter((l) => l.startsWith('- #'))
      .map((line) => {
        const m = line.match(/^- #(\d+) \[([^\]]*)\]\s*(.*)$/);
        if (!m) return '';
        const [, id, ns, rest] = m;
        const sub = rest.match(/^\*\*(.+?)\*\*\s*(.*)$/);
        const subject = sub ? sub[1] : '';
        const body = sub ? sub[2] : rest;
        return `<div class="item">
          <div class="body">
            <div>${subject ? `<span class="tag">${subject}</span>` : ''}${escapeHtml(body)}</div>
            <div class="meta">#${id} · ${ns}</div>
          </div>
          <button class="del" data-id="${id}" title="删除">✕</button>
        </div>`;
      })
      .join('');
    box.querySelectorAll('.del').forEach((btn) => {
      btn.onclick = async () => {
        await api('zhmem_forget', { item_id: Number(btn.dataset.id) });
        loadMemories();
        loadStats();
      };
    });
  } catch (error) {
    box.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function addMemory() {
  const text = $('mem-text').value.trim();
  if (!text) return;
  await api('zhmem_remember', {
    text,
    subject: $('mem-subject').value.trim(),
    namespace: $('mem-ns').value.trim() || 'default',
  });
  $('mem-text').value = '';
  $('mem-subject').value = '';
  loadMemories();
  loadStats();
}

// ---- 知识库 --------------------------------------------------------------

async function importKnowledge() {
  const file = $('kb-file').files?.[0];
  const msg = $('kb-msg');
  if (!file) { msg.textContent = '先选一个 JSON 文件。'; return; }
  try {
    const entries = JSON.parse(await file.text());
    if (!Array.isArray(entries)) throw new Error('文件内容必须是数组');
    const r = await api('zhmem_import_knowledge', {
      entries,
      namespace: $('kb-ns').value.trim() || 'mine',
      replace: true,
    });
    msg.textContent = r.message;
    loadKb();
    loadStats();
  } catch (error) {
    msg.textContent = `导入失败：${error.message}`;
  }
}

async function downloadTemplate() {
  const r = await api('zhmem_knowledge_template', {});
  const blob = new Blob([r.content], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'my-knowledge.json';
  a.click();
  URL.revokeObjectURL(a.href);
  $('kb-msg').textContent = `模板已下载（${r.path}）。`;
}

async function loadKb() {
  const box = $('kb-list');
  try {
    const stats = await fetch('/api/stats').then((x) => x.json());
    const rows = [
      ['内置知识库', `${stats.builtinKnowledge} 条`],
      ['导入的知识', `${stats.importedKnowledge} 条`],
      ['个人记忆', `${stats.personalMemories} 条`],
    ];
    box.innerHTML = rows
      .map(([k, v]) => `<div class="item"><div class="body"><b>${k}</b><div class="meta">${v}</div></div></div>`)
      .join('');
  } catch (error) {
    box.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

// ---- 状态 ----------------------------------------------------------------

async function loadStats() {
  try {
    const r = await api('zhmem_stats', {});
    $('sidenums').innerHTML = `知识库 ${r.builtinKnowledge} 条<br>我的知识 ${r.importedKnowledge} 条<br>记忆 ${r.personalMemories} 条`;
    $('about-kv').innerHTML = `
      <dt>版本</dt><dd>${r.version}</dd>
      <dt>数据库</dt><dd><code>${escapeHtml(r.db)}</code></dd>
      <dt>内置知识库</dt><dd>${r.builtinKnowledge} 条</dd>
      <dt>导入的知识</dt><dd>${r.importedKnowledge} 条</dd>
      <dt>个人记忆</dt><dd>${r.personalMemories} 条</dd>`;
  } catch {
    $('sidenums').textContent = '未连接';
  }
}

// ---- 启动 ----------------------------------------------------------------

document.querySelectorAll('.nav').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'memory') loadMemories();
    if (btn.dataset.view === 'kb') loadKb();
  };
});

$('go').onclick = ask;
$('q').onkeydown = (e) => { if (e.key === 'Enter') ask(); };
$('offline').onchange = (e) => { offline = e.target.checked; };
$('mem-add').onclick = addMemory;
$('mem-refresh').onclick = loadMemories;
$('kb-import').onclick = importKnowledge;
$('kb-tpl').onclick = downloadTemplate;
$('kb-refresh').onclick = loadKb;

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => { $('verline').textContent = `v${s.version} · 中文优先的记忆检索`; })
  .catch(() => {});

loadStats();
