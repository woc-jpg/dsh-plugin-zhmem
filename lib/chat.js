// Conversation on top of retrieval.
//
// Two modes, and the difference is visible to the user on purpose:
//
//   * A model is configured  -> the turns go to an OpenAI-compatible endpoint
//     with the retrieved material pasted in as context, and the reply reads
//     like a conversation.
//   * No model configured    -> the reply is assembled here from the same
//     retrieval: what the knowledge base says, what the files say, what the web
//     says. It is labelled as composed rather than generated, because claiming
//     otherwise would be a lie the user cannot check.
//
// Everything the model is allowed to claim comes from `context`, which is
// retrieval output. Asked something absent from it, the instruction is to say so
// rather than fill the gap - a chat window that invents an answer about the
// user's own documents is worse than one that says "not in these files".

import { DatabaseSync } from 'node:sqlite';

import { utcnow } from './store.js';
import { contentSegments, stripQueryNoise } from './text.js';

const HISTORY_TURNS = 12;
const MAX_CONTEXT_CHARS = 6000;

// A follow-up whose topic lives in the previous turn: 「那边」「刚才那个」
// 「呢」and friends. Without this, a query made almost entirely of anaphora
// retrieves on the anaphora's own bigrams - measured live, 「那边住宿贵吗」
// after 「敦煌三天怎么安排」 ranked 日本旅游攻略 first (0.332) and pushed
// 敦煌 to third (0.302), because 住宿 is a real topic for other entries while
// 敦煌 only arrived through the 0.6-weight context channel. Injecting the
// previous topic fixes that - but doing it unconditionally would derail a
// genuine topic switch (膝盖疼怎么办 after 敦煌 matched 敦煌). So the gate
// has to be closed for a fresh topic and open only for a real follow-up.
const ANAPHORA_MARKERS = [
  '那边', '那里', '那儿', '这个', '那个', '这些', '那些', '刚才', '上次',
  '之前', '前面', '继续', '接着', '再说', '那么', '这样的话', '同上', '它',
];
const ANAPHORA_TAIL = ['呢', '吗', '吧'];

/** Is this turn leaning on the previous one instead of naming its own topic? */
export function isFollowUp(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (ANAPHORA_MARKERS.some((w) => s.includes(w))) return true;
  // A bare 「住宿呢」/「那边」has too little content to stand alone. Count CJK
  // characters outside the generic filler the text layer already strips; two
  // or fewer means the user is pointing, not naming.
  const cjk = contentSegments(stripQueryNoise(s))
    .filter(([kind]) => kind === 'cjk')
    .reduce((n, [, run]) => n + [...run].length, 0);
  if (cjk > 0 && cjk <= 2 && ANAPHORA_TAIL.some((w) => s.endsWith(w))) return true;
  return false;
}

/** The leading topic of the previous turn, capped at four characters. */
export function previousTopic(text) {
  const segs = contentSegments(stripQueryNoise(String(text ?? ''))).filter(([kind]) => kind === 'cjk');
  if (!segs.length) return '';
  return [...segs[0][1]].slice(0, 4).join('');
}

/**
 * The query to search with. A follow-up borrows the previous turn's topic; a
 * fresh topic is searched as typed. The original text is preserved in the log
 * and sent to the model unchanged - only retrieval sees the resolved query.
 */
export function resolveQuery(text, previousUserTurn) {
  const query = String(text ?? '').trim();
  if (!previousUserTurn || !isFollowUp(query)) return { query, searchQuery: query, resolved: false };
  const topic = previousTopic(previousUserTurn);
  if (!topic || query.includes(topic)) return { query, searchQuery: query, resolved: false };
  return { query, searchQuery: `${topic} ${query}`, resolved: true, topic };
}

export const DEFAULT_SYSTEM = [
  '你是 zhmem 的对话助手，用中文回答，语气平实，不要客套。',
  '下面会给你「检索到的材料」，来自用户自己的知识库、个人记忆、本地文件和网络。',
  '回答时以这些材料为准；材料里没有的内容，直接说没找到，不要编。',
  '引用材料时用「（来源：文件名或条目标题）」标注，不要虚构出处。',
].join('\n');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at REAL    NOT NULL,
    meta       TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id);
`;

/** Persistent turn history, one row per message. */
export class MessageLog {
  constructor(db) {
    this.db = db;
    db.exec(SCHEMA);
    this._stAdd = db.prepare('INSERT INTO messages (session, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)');
    this._stSession = db.prepare('SELECT * FROM messages WHERE session = ? ORDER BY id');
    this._stRecent = db.prepare('SELECT * FROM messages WHERE session = ? ORDER BY id DESC LIMIT ?');
    this._stClear = db.prepare('DELETE FROM messages WHERE session = ?');
    this._stSessions = db.prepare(`
      SELECT session, count(*) AS turns, max(created_at) AS at
      FROM messages GROUP BY session ORDER BY at DESC LIMIT ?
    `);
  }

  add(session, role, content, meta = {}) {
    this._stAdd.run(session, role, content, utcnow(), JSON.stringify(meta));
  }

  history(session, limit = HISTORY_TURNS) {
    return this._stRecent.all(session, limit).reverse().map((r) => ({ role: r.role, content: r.content, meta: safe(r.meta) }));
  }

  all(session) {
    return this._stSession.all(session).map((r) => ({ role: r.role, content: r.content, meta: safe(r.meta), at: r.created_at }));
  }

  clear(session) {
    this._stClear.run(session);
  }

  sessions(limit = 30) {
    return this._stSessions.all(limit).map((r) => ({ session: r.session, turns: r.turns, at: r.at }));
  }
}

function safe(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

/**
 * Build the context block from retrieval results.
 *
 * Order matters: local knowledge and personal memory first (they are the user's
 * own material and the model should prefer them), files next, web last. Each
 * chunk is labelled so a citation can point at something real.
 */
export function buildContext({ local = [], files = [], web = [] } = {}) {
  const parts = [];
  let budget = MAX_CONTEXT_CHARS;

  const push = (label, text) => {
    if (budget <= 0) return;
    const clipped = text.length > budget ? `${text.slice(0, budget)}…` : text;
    parts.push(`${label}\n${clipped}`);
    budget -= clipped.length;
  };

  for (const hit of local) {
    const title = hit.memory.subject || hit.memory.meta?.id || `#${hit.memory.id}`;
    push(`【知识库/${hit.memory.namespace}】${title}`, hit.memory.body);
  }
  for (const file of files) {
    push(`【文件】${file.name}（${file.path}）`, file.body ?? file.snippet ?? '');
  }
  for (const r of web) {
    push(`【网络】${r.title}（${r.url}）`, r.snippet ?? '');
  }
  return parts.join('\n\n');
}

/**
 * The no-model answer.
 *
 * Written as prose rather than a bullet dump so it reads as a reply, but every
 * sentence is traceable to a hit and the whole thing is prefixed with what it
 * is. If the collection is empty it says so instead of padding.
 */
export function composeAnswer({ query, local = [], files = [], web = [] } = {}) {
  const blocks = [];
  const lead = local[0];

  if (lead) {
    const title = lead.memory.subject ? `「${lead.memory.subject}」` : '相关内容';
    blocks.push(`按知识库${title}的说法：${lead.memory.body}`);
    const rest = local.slice(1);
    if (rest.length) {
      const more = rest.map((h) => (h.memory.subject ? h.memory.subject : h.memory.body.slice(0, 40))).join('、');
      blocks.push(`另外还找到了${more}，可能也相关。`);
    }
  }

  if (files.length) {
    const top = files.slice(0, 3);
    const list = top.map((f) => `\`${f.name}\``).join('、');
    blocks.push(`你自己的文件里，${list} 提到过这个。打开看原文更准，下面是摘出来的片段：`);
    for (const f of top) {
      if (f.snippet) blocks.push(`- ${f.name}：${f.snippet}`);
    }
  }

  if (web.length) {
    const list = web.slice(0, 3).map((r) => `[${r.title}](${r.url})`).join('、');
    blocks.push(`知识库和文件里都没有，联网查到这些：${list}。`);
  }

  if (!blocks.length) {
    return `关于「${query}」，知识库、你的文件和联网都没找到能用的内容。换个说法，或者把这条信息存进记忆库、导入相关文件。`;
  }
  return blocks.join('\n\n');
}

/**
 * Streaming client for any OpenAI-compatible /chat/completions endpoint.
 *
 * `stream: true` with SSE parsing, because a 20-second silence before the first
 * word is the difference between "thinking" and "broken". Falls back to a single
 * JSON body when the server ignores the stream flag.
 */
export async function streamChat({ url, apiKey, model, messages, temperature = 0.3, timeout = 120, signal = null }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型接口 ${res.status}：${detail.slice(0, 300) || res.statusText}`);
    }

    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      return { text, usage: data?.usage ?? null, streamed: false };
    }

    let out = '';
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) out += delta;
        } catch {
          // A malformed frame is not worth aborting a reply for.
        }
      }
    }
    return { text: out, usage: null, streamed: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The conversation engine.
 *
 * Holds no per-session state of its own: the log is the state, so a page reload
 * or a restart continues the same thread.
 */
export class ChatEngine {
  constructor({ retriever, files = null, log, config = {} } = {}) {
    this.retriever = retriever;
    this.files = files;
    this.log = log;
    this.config = {
      url: config.url ?? null,
      apiKey: config.apiKey ?? null,
      model: config.model ?? null,
      system: config.system ?? DEFAULT_SYSTEM,
      temperature: config.temperature ?? 0.3,
    };
  }

  get hasModel() {
    return Boolean(this.config.url && this.config.model);
  }

  describe() {
    return {
      model: this.hasModel ? this.config.model : null,
      endpoint: this.hasModel ? safeOrigin(this.config.url) : null,
      mode: this.hasModel ? 'model' : 'composed',
    };
  }

  /**
   * Retrieve for the turn, then answer.
   *
   * Retrieval always runs, even in model mode: the model needs material, and the
   * UI needs citations that point at real rows. The `sources` in the result are
   * what the reader can click, independent of what the model chose to say.
   */
  async send({ session = 'default', text, useFiles = true, useWeb = null, images = false } = {}) {
    const history = this.log.history(session);
    const previousTurn = history.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? null;
    // Resolve anaphora for *retrieval only*. The log and the model still see
    // exactly what the user typed, so the transcript stays faithful.
    const { query, searchQuery, resolved, topic } = resolveQuery(String(text ?? '').trim(), previousTurn);
    if (!query) throw new Error('说什么都行，别发空的');

    // The retriever wants the previous turn verbatim: 「那」and 「上次」resolve
    // against it, and a summary would lose exactly the words being pointed at.
    const recent = previousTurn ? [previousTurn] : [];

    const answer = await this.retriever.ask(searchQuery, {
      recent,
      images: images === true,
      ...(useWeb === null ? {} : { web: useWeb }),
    });

    let fileHits = [];
    if (useFiles && this.files) {
      fileHits = this.files.search(searchQuery, { limit: 4 });
      // The snippet is enough for display but not for the model: it needs the
      // surrounding text to answer from. Read the stored body back for the top
      // two only - a whole file would swamp the context budget.
      for (const hit of fileHits.slice(0, 2)) {
        const row = this.files.db.prepare('SELECT body FROM files WHERE id = ?').get(hit.id);
        if (row?.body) hit.body = row.body.slice(0, 2500);
      }
    }

    const context = buildContext({ local: answer.local, files: fileHits, web: answer.web });
    const sources = [
      ...answer.local.map((h) => ({
        kind: 'kb',
        title: h.memory.subject || `#${h.memory.id}`,
        detail: h.memory.namespace,
        score: Number(h.score.toFixed(3)),
      })),
      ...fileHits.map((f) => ({
        kind: 'file',
        title: f.name,
        detail: f.path,
        score: f.score,
      })),
      ...answer.web.map((r) => ({ kind: 'web', title: r.title, detail: r.url })),
    ];

    let reply;
    let usedModel = false;
    if (this.hasModel) {
      try {
        const messages = [
          { role: 'system', content: this.config.system },
          ...(context ? [{ role: 'system', content: `检索到的材料：\n\n${context}` }] : []),
          ...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: query },
        ];
        const result = await streamChat({
          url: this.config.url,
          apiKey: this.config.apiKey,
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
        });
        if (result.text.trim()) {
          reply = result.text.trim();
          usedModel = true;
        } else {
          reply = composeAnswer({ query, local: answer.local, files: fileHits, web: answer.web });
        }
      } catch (error) {
        // A dead endpoint must not swallow the retrieval we already paid for.
        reply = `（模型没连上：${error.message}）\n\n${composeAnswer({ query, local: answer.local, files: fileHits, web: answer.web })}`;
      }
    } else {
      reply = composeAnswer({ query, local: answer.local, files: fileHits, web: answer.web });
    }

    this.log.add(session, 'user', query);
    this.log.add(session, 'assistant', reply, { usedModel, sources: sources.length });

    return {
      reply,
      composed: !usedModel,
      usedWeb: answer.usedWeb,
      sources,
      images: answer.images.map((r) => ({ title: r.title, url: r.url, page: r.page })),
      fileHits: fileHits.map((f) => ({ name: f.name, path: f.path, score: f.score, snippet: f.snippet })),
      // Surfaced so the UI can say "按你说的『敦煌』接着找" when it resolved an
      // anaphora - a silent topic guess is exactly the kind that feels uncanny.
      resolved: resolved || false,
      topic: topic || null,
    };
  }
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export default ChatEngine;
