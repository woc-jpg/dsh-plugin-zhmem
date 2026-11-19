// Front end. Deliberately plain: no framework, no build step. A user who
// downloads the zip gets a working window without running npm install, and the
// file stays readable for anyone who wants to change it.

const $ = (id) => document.getElementById(id);

let offline = false;
let session = 'default';
let busy = false;

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
    if (t === '---') {
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      continue;
    }
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 对话 ----------------------------------------------------------------

function turnNode(role, html, foot = '') {
  const el = document.createElement('div');
  el.className = `turn ${role === 'user' ? 'user' : 'bot'}`;
  el.innerHTML = `
    <div class="who">${role === 'user' ? '你' : '知'}</div>
    <div class="bubble">${html}${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
  return el;
}

function sourceFoot(result) {
  if (!result.sources?.length) return '';
  const bits = result.sources.slice(0, 6).map((s) => {
    if (s.kind === 'file') return `<span class="src"><b>文件</b> ${escapeHtml(s.title)}</span>`;
    if (s.kind === 'kb') return `<span class="src"><b>知识库</b> ${escapeHtml(s.title)}</span>`;
    return `<span class="src"><b>网络</b> <a href="${escapeHtml(s.detail)}" target="_blank" rel="noreferrer">${escapeHtml(s.title)}</a></span>`;
  });
  const badge = result.composed
    ? '<span class="badge warn">未配模型 · 检索结果直出</span>'
    : '<span class="badge">模型作答</span>';
  return `${badge}${bits.join('')}`;
}

function appendTurn(role, html, foot = '') {
  const log = $('chat-log');
  log.querySelector('.chat-empty')?.remove();
  const el = turnNode(role, html, foot);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function loadChat() {
  const log = $('chat-log');
  try {
    const res = await fetch(`/api/chat/history?session=${encodeURIComponent(session)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '读取历史失败');
    log.innerHTML = '';
    if (!data.messages.length) {
      log.innerHTML = `<div class="chat-empty">
        <p>问点什么。回答会先看你自己的知识库、记忆和已索引的文件，本地不够才联网。</p>
        <p class="muted">比如「敦煌三天怎么安排」「我文件里关于预算的部分说了什么」「继续刚才那个话题」。</p>
      </div>`;
    } else {
      for (const m of data.messages) {
        if (m.role === 'user') appendTurn('user', `<p>${escapeHtml(m.content)}</p>`);
        else appendTurn('assistant', render(m.content), m.meta?.usedModel === false ? '<span class="badge warn">未配模型 · 检索结果直出</span>' : '');
      }
    }
    const mode = data.mode ?? {};
    $('chat-mode').textContent = mode.model
      ? `模型 ${mode.model} · ${mode.endpoint}`
      : '没有配置模型：回答由检索结果直接组织，不是模型生成的';
    log.scrollTop = log.scrollHeight;
  } catch (error) {
    log.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

async function sendChat() {
  if (busy) return;
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  appendTurn('user', `<p>${escapeHtml(text)}</p>`);

  busy = true;
  $('chat-send').disabled = true;
  const pending = appendTurn('assistant', '<p class="muted">在想…</p>');

  try {
    const result = await api('chat', {
      session,
      text,
      use_files: true,
      web_mode: offline ? 'never' : 'auto',
    });
    const resolved = result.resolved
      ? `<span class="badge warn">按「${escapeHtml(result.topic)}」接着找</span>`
      : '';
    const body = render(result.reply);
    const foot = result.sources?.length ? sourceFoot(result) : '';
    pending.querySelector('.bubble').innerHTML = resolved + body + (foot ? `<div class="foot">${foot}</div>` : '');
  } catch (error) {
    pending.querySelector('.bubble').innerHTML = `<p class="muted">出错了：${escapeHtml(error.message)}</p>`;
  } finally {
    busy = false;
    $('chat-send').disabled = false;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    loadStats();
  }
}

function newChat() {
  session = `s-${Date.now().toString(36)}`;
  $('chat-log').innerHTML = `<div class="chat-empty"><p>新的一段对话。上面那段还留着，下次想接上就用「清空」之前的会话名。</p></div>`;
  $('chat-input').focus();
}

async function clearChat() {
  await api('chat/clear', { session });
  $('chat-log').innerHTML = `<div class="chat-empty"><p>清空了。</p></div>`;
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

// ---- 文件 ----------------------------------------------------------------

async function indexFiles(force = false) {
  const path = $('file-path').value.trim();
  const msg = $('file-msg');
  if (!path) { msg.textContent = '先填一个文件夹路径。'; return; }
  msg.textContent = '正在读取…';
  try {
    const r = await api('files/index', { path, force });
    msg.textContent = `${r.root}：新增 ${r.added}，更新 ${r.updated}，没变 ${r.unchanged}，移出 ${r.removed}`;
    loadFileRoots();
    loadStats();
  } catch (error) {
    msg.textContent = `索引失败：${error.message}`;
  }
}

async function searchFiles() {
  const query = $('file-q').value.trim();
  const box = $('file-hits');
  if (!query) return;
  box.innerHTML = '<p class="muted">搜索中…</p>';
  try {
    const r = await api('files/search', { query, limit: 10 });
    if (!r.hits.length) { box.innerHTML = '<p class="muted">没有匹配的文件。</p>'; return; }
    box.innerHTML = r.hits.map((h) => `
      <div class="item file-hit">
        <div class="body">
          <div class="name">${escapeHtml(h.name)} <span class="score">${h.score}</span></div>
          <div class="path">${escapeHtml(h.path)}</div>
          ${h.snippet ? `<div class="snip">${escapeHtml(h.snippet)}</div>` : ''}
        </div>
      </div>`).join('');
  } catch (error) {
    box.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

async function loadFileRoots() {
  const box = $('file-roots');
  try {
    const res = await fetch('/api/files/stats').then((x) => x.json());
    if (!res.files) { box.innerHTML = '<p class="muted">还没有索引任何目录。</p>'; return; }
    box.innerHTML = res.roots.map((r) => `
      <div class="item">
        <div class="body">
          <div>${escapeHtml(r.root)}</div>
          <div class="meta">${r.files} 个文件 · ${r.chars} 字</div>
        </div>
        <button class="del" data-root="${escapeHtml(r.root)}" title="移出索引">✕</button>
      </div>`).join('');
    box.querySelectorAll('.del').forEach((btn) => {
      btn.onclick = async () => {
        await api('files/forget', { root: btn.dataset.root });
        loadFileRoots();
        loadStats();
      };
    });
  } catch (error) {
    box.innerHTML = `<p class="muted">${error.message}</p>`;
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
    const files = await fetch('/api/files/stats').then((x) => x.json()).catch(() => ({ files: 0 }));
    $('sidenums').innerHTML = `知识库 ${r.builtinKnowledge} 条<br>我的知识 ${r.importedKnowledge} 条<br>记忆 ${r.personalMemories} 条<br>文件 ${files.files ?? 0} 个`;
    $('about-kv').innerHTML = `
      <dt>版本</dt><dd>${r.version}</dd>
      <dt>数据库</dt><dd><code>${escapeHtml(r.db)}</code></dd>
      <dt>内置知识库</dt><dd>${r.builtinKnowledge} 条</dd>
      <dt>导入的知识</dt><dd>${r.importedKnowledge} 条</dd>
      <dt>个人记忆</dt><dd>${r.personalMemories} 条</dd>
      <dt>已索引文件</dt><dd>${files.files ?? 0} 个</dd>`;
  } catch {
    $('sidenums').textContent = '未连接';
  }
}

// ---- 启动 ----------------------------------------------------------------

document.querySelectorAll('.nav').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${btn.dataset.view}`));
    const view = btn.dataset.view;
    if (view === 'chat') loadChat();
    if (view === 'files') { loadFileRoots(); loadStats(); }
    if (view === 'memory') loadMemories();
    if (view === 'kb') loadKb();
  };
});

$('chat-send').onclick = sendChat;
$('chat-new').onclick = newChat;
$('chat-clear').onclick = clearChat;
$('chat-input').addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter breaks the line - the convention every chat box
  // the user already uses follows, and getting it backwards is the kind of
  // thing that makes a window feel foreign.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  }
});
$('chat-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`;
});

$('go').onclick = ask;
$('q').onkeydown = (e) => { if (e.key === 'Enter') ask(); };
$('offline').onchange = (e) => { offline = e.target.checked; };
$('file-add').onclick = () => indexFiles(false);
$('file-force').onclick = () => indexFiles(true);
$('file-search').onclick = searchFiles;
$('file-q').onkeydown = (e) => { if (e.key === 'Enter') searchFiles(); };
$('file-refresh').onclick = loadFileRoots;
$('mem-add').onclick = addMemory;
$('mem-refresh').onclick = loadMemories;
$('kb-import').onclick = importKnowledge;
$('kb-tpl').onclick = downloadTemplate;
$('kb-refresh').onclick = loadKb;

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    $('verline').textContent = `v${s.version} · 中文优先的记忆检索`;
    if (!s.chat?.model) {
      $('chat-hint').textContent = '当前没有配置模型：回答是把检索结果写成一段话，不是模型编的。想接模型就在 zhmem.env 里填 ZHMEM_MODEL_URL 和 ZHMEM_MODEL。';
    }
  })
  .catch(() => {});

loadChat();
loadStats();
