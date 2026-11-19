// Personal memory store: one SQLite file, FTS5 index, coverage scoring.
//
// Ported from zhmem/store.py, with `node:sqlite` instead of the Python binding.
// FTS5 ships inside Node 22+, so there is no native module to build and no
// Python interpreter to find - which is the whole point of the plugin.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import { fold } from './synonyms.js';
import * as T from './text.js';

export const VERSION = '0.2.0';

// `bigram` names the *approach* (CJK text pre-tokenised into unigrams and
// bigrams, then indexed by `unicode61`), not a built-in tokeniser. The name is
// kept identical to the Python library so a database written by either side
// behaves the same.
const TOKENIZERS = {
  bigram: "'unicode61 remove_diacritics 2'",
  trigram: "'trigram'",
};

function schema(tokenizer) {
  return `
CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace     TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'note',
    subject       TEXT    NOT NULL DEFAULT '',
    salience      REAL    NOT NULL DEFAULT 0.5,
    search_text   TEXT    NOT NULL DEFAULT '',
    search_source TEXT,
    created_at    REAL    NOT NULL,
    last_hit_at   REAL,
    hit_count     INTEGER NOT NULL DEFAULT 0,
    meta          TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS items_ns ON items(namespace, created_at);

-- External-content FTS5: the index is derived from the items table by trigger,
-- so a row is never duplicated and a direct UPDATE cannot desynchronise it.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    search_text,
    content='items',
    content_rowid='id',
    tokenize=${tokenizer}
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, search_text)
    VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, search_text)
    VALUES ('delete', old.id, old.search_text);
    INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
`;
}

export function defaultDbPath() {
  const override = process.env.ZHMEM_DB;
  if (override) return expandUser(override);
  return join(homedir(), '.workbuddy', 'zhmem-memory.db');
}

export function expandUser(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function utcnow() {
  return Date.now() / 1000;
}

export class Memory {
  constructor(row) {
    this.id = row.id;
    this.namespace = row.namespace;
    this.body = row.body;
    this.kind = row.kind;
    this.subject = row.subject;
    this.salience = row.salience;
    this.created_at = row.created_at;
    this.last_hit_at = row.last_hit_at;
    this.hit_count = row.hit_count;
    this.meta = safeJson(row.meta);
  }

  get search_text() {
    return [this.subject, this.body].filter(Boolean).join(' ');
  }

  toString() {
    return this.subject ? `${this.subject}: ${this.body}` : this.body;
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}') ?? {};
  } catch {
    return {};
  }
}

/**
 * One recalled memory and the evidence that produced it.
 *
 * `parts` is exposed because the decision "is this local hit good enough, or
 * should we go to the web" reads `lexical`/`semantic`/`subject` - never `score`.
 * `score` includes recency and salience, which are worth up to 0.25 on their own
 * and would make every fresh entry look relevant.
 */
export class Recalled {
  constructor(memory, parts, score) {
    this.memory = memory;
    this.parts = parts;
    this.score = score;
  }

  get id() {
    return this.memory.id;
  }

  get body() {
    return this.memory.body;
  }
}

export class MemoryStore {
  constructor(path = ':memory:', options = {}) {
    const {
      normalize = fold,
      queryNormalize = null,
      tokenizer = 'bigram',
      weights = null,
      halfLifeDays = 30.0,
      charTier = true,
      contextWeight = 0.6,
      subjectBonus = 0.0,
      semanticFloor = 0.20,
      embedder = null,
      clock = utcnow,
    } = options;

    if (!TOKENIZERS[tokenizer]) {
      throw new Error(`unknown tokenizer: ${tokenizer} (expected one of ${Object.keys(TOKENIZERS)})`);
    }

    this.path = path;
    this.normalize = normalize ?? ((x) => x);
    this.queryNormalize = queryNormalize ?? this.normalize;
    this.tokenizer = tokenizer;
    this.charTier = charTier;
    this.halfLifeDays = halfLifeDays;
    this.contextWeight = contextWeight;
    this.semanticFloor = semanticFloor;
    this.embedder = embedder;
    this.clock = clock;
    this._idfCache = new Map();

    // subject_bonus is opt-in per store, never a default: a KB store sets it to
    // 1.0 because entry titles are curated, but a personal store leaves it at 0
    // because empty subjects would otherwise manufacture phantom evidence.
    this.weights = {
      lexical: 0.45,
      semantic: 0.30,
      recency: 0.10,
      salience: 0.15,
      subject: subjectBonus,
      ...(weights ?? {}),
    };

    if (path !== ':memory:') {
      const abs = isAbsolute(path) ? path : expandUser(path);
      mkdirSync(dirname(abs), { recursive: true });
      this.path = abs;
    }

    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 15000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(schema(TOKENIZERS[tokenizer]));
    this._prepare();
  }

  _prepare() {
    this._stInsert = this.db.prepare(
      `INSERT INTO items (namespace, body, kind, subject, salience, search_text, search_source, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stById = this.db.prepare('SELECT * FROM items WHERE id = ?');
    this._stDelete = this.db.prepare('DELETE FROM items WHERE id = ?');
    this._stAll = this.db.prepare('SELECT * FROM items WHERE namespace = ? ORDER BY created_at DESC LIMIT ?');
    this._stCount = this.db.prepare('SELECT COUNT(*) AS n FROM items');
    this._stCountNs = this.db.prepare('SELECT namespace, COUNT(*) AS n FROM items GROUP BY namespace');
    this._stTouch = this.db.prepare('UPDATE items SET last_hit_at = ?, hit_count = hit_count + 1 WHERE id = ?');
    this._stText = this.db.prepare('SELECT id, namespace, search_text FROM items');
  }

  /**
   * Index a pre-concatenated source string with the current settings.
   *
   * Normalisation belongs *inside* here rather than at the call sites, because
   * `searchText` arrives already concatenated from the knowledge base. Doing
   * `indexText(raw)` at the call site folded subject and body separately but
   * skipped the source string, so a KB entry's hand-written tags were indexed
   * verbatim: 浓茶 stayed 浓茶 instead of folding to 茶, and the entry became
   * unreachable through the canonical word.
   */
  _indexFromSource(source) {
    const raw = this.normalize(source ?? '');
    if (this.tokenizer === 'trigram') return raw;
    return T.indexText(raw);
  }

  /** Store one memory. `searchText` overrides the derived, tokenised text. */
  add(namespace, body, options = {}) {
    const {
      kind = 'note',
      subject = '',
      salience = 0.5,
      meta = null,
      searchText = null,
      createdAt = null,
    } = options;

    const clean = String(body ?? '').trim();
    if (!clean) throw new Error('body must not be empty');

    // The stored body and subject stay verbatim: folding is an indexing concern,
    // and folding on write would show the reader a word they never typed
    // (浓茶 rendered as 茶). Only `search_text` is normalised.
    const subjectText = String(subject ?? '');
    const source = searchText ?? [subjectText, clean].filter(Boolean).join(' ').trim();

    const info = this._stInsert.run(
      namespace,
      clean,
      kind,
      subjectText,
      clamp(salience, 0, 1),
      this._indexFromSource(source),
      source,
      createdAt ?? this.clock(),
      JSON.stringify(meta ?? {}),
    );

    this._idfCache.delete(namespace);
    return Number(info.lastInsertRowid);
  }

  get(id) {
    const row = this._stById.get(id);
    return row ? new Memory(row) : null;
  }

  forget(id) {
    const row = this._stById.get(id);
    if (!row) return false;
    this._stDelete.run(id);
    this._idfCache.delete(row.namespace);
    return true;
  }

  clear(namespace = null) {
    if (namespace === null) this.db.exec('DELETE FROM items');
    else this.db.prepare('DELETE FROM items WHERE namespace = ?').run(namespace);
    this._idfCache.clear();
  }

  count(namespace = null) {
    if (namespace === null) return this._stCount.get().n;
    return this._stAll.all(namespace, 1_000_000).length;
  }

  counts() {
    const out = {};
    for (const row of this._stCountNs.all()) out[row.namespace] = row.n;
    return out;
  }

  list(namespace = null, { limit = 20, kind = null, kinds = null } = {}) {
    const rows = namespace === null
      ? this.db.prepare('SELECT * FROM items ORDER BY created_at DESC LIMIT ?').all(limit)
      : this._stAll.all(namespace, limit);
    let memories = rows.map((r) => new Memory(r));
    if (kind) memories = memories.filter((m) => m.kind === kind);
    // `kinds` exists because callers mostly want "the user's own memories" and
    // the store holds three kinds at once - the built-in KB, imported knowledge,
    // and notes. Filtering after the LIMIT is fine: the seeding inserts happen
    // once at startup, so curated rows cluster at low ids rather than crowding
    // out recent notes.
    if (kinds) memories = memories.filter((m) => kinds.includes(m.kind));
    return memories;
  }

  /**
   * Rebuild `search_text` for every row, in place.
   *
   * `search_source` keeps the text a row was indexed from. Recomputing from
   * subject+body instead is the bug this column exists to prevent: a KB entry
   * carries hand-written tags that appear in neither field, and reindexing used
   * to silently drop them - the entry survived but became unfindable by tag.
   */
  reindex() {
    const rows = this._stText.all();
    const update = this.db.prepare('UPDATE items SET search_text = ?, search_source = ? WHERE id = ?');
    let changed = 0;
    for (const row of rows) {
      const source = row.search_source ?? reconstruct(this.db, row.id);
      const want = this._indexFromSource(source);
      if (want !== row.search_text || source !== row.search_source) {
        update.run(want, source, row.id);
        changed += 1;
      }
    }
    this._idfCache.clear();
    return changed;
  }

  /**
   * Recall memories matching `query`, best first.
   *
   * Two candidate sets are merged rather than short-circuited: the current query
   * and the previous turn. Returning early when the FTS query yields nothing is
   * how "vector-only recall is always empty" shipped - an embedding hit never
   * got a chance to be scored.
   */
  recall(namespace, query, options = {}) {
    const {
      limit = 8,
      candidateLimit = 200,
      kinds = null,
      recent = [],
    } = options;

    const clean = this.queryNormalize(T.stripQueryNoise(query ?? '')).trim();
    const ctxQuery = recent.length ? String(recent[recent.length - 1] ?? '') : '';

    const current = clean ? this._candidates(namespace, clean, candidateLimit) : [];
    const context = ctxQuery.trim()
      ? this._candidates(namespace, this.queryNormalize(T.stripQueryNoise(ctxQuery)).trim(), candidateLimit)
      : [];

    // Union, not either/or: keep every candidate from both passes.
    const byId = new Map();
    for (const row of current) byId.set(row.id, row);
    for (const row of context) if (!byId.has(row.id)) byId.set(row.id, row);
    if (!byId.size) return [];

    const want = T.queryTerms(clean || query || '');
    const wantCtx = ctxQuery.trim() ? T.queryTerms(this.queryNormalize(T.stripQueryNoise(ctxQuery))) : new Map();

    const lexicalCur = want.size ? this._lexicalScores(byId, want) : new Map();
    const lexicalCtx = wantCtx.size ? this._lexicalScores(byId, wantCtx) : new Map();

    const wanted = kinds ? new Set([].concat(kinds)) : null;
    const { idf, mean } = this.weights.subject ? this._charIdf(namespace) : { idf: null, mean: 1.0 };

    const hits = [];
    for (const row of byId.values()) {
      const memory = new Memory(row);

      const lex = Math.max(lexicalCur.get(row.id) ?? 0, this.contextWeight * (lexicalCtx.get(row.id) ?? 0));
      const semantic = this._semantic(memory, query ?? '');
      const subjectHit = this._subjectHit(memory, clean, idf, mean);

      // Skip only when *every* evidence channel is empty. A semantic-only or
      // subject-only hit is a real hit and must still be scored. This check runs
      // before the kind filter so a filtered-out row does not pay for scoring
      // it would never use.
      if (lex <= 0 && semantic <= 0 && subjectHit <= 0) continue;
      if (wanted && !wanted.has(memory.kind)) continue;

      const parts = {
        lexical: lex,
        semantic,
        recency: this._recency(memory),
        salience: clamp(memory.salience, 0, 1),
        subject: subjectHit,
      };
      let score = 0;
      for (const k of Object.keys(parts)) score += parts[k] * (this.weights[k] ?? 0);
      hits.push(new Recalled(memory, parts, score));
    }

    hits.sort((a, b) => (b.score - a.score) || (b.memory.id - a.memory.id));
    const top = hits.slice(0, limit);
    for (const h of top) this._stTouch.run(this.clock(), h.memory.id);
    return top;
  }

  _candidates(namespace, query, limit) {
    const match = this._matchExpression(query);
    if (!match) return [];
    try {
      return this.db
        .prepare(
          `SELECT i.*, bm25(items_fts) AS rank
             FROM items_fts JOIN items i ON i.id = items_fts.rowid
            WHERE items_fts MATCH ? AND i.namespace = ?
            ORDER BY rank LIMIT ?`,
        )
        .all(match, namespace, limit);
    } catch {
      // A query of pure punctuation can produce a MATCH expression FTS5 rejects;
      // an empty candidate set is the correct answer, not an error.
      return [];
    }
  }

  /**
   * FTS5 MATCH expression built from the query's terms.
   *
   * The trigram tokeniser needs substrings of three characters - a two-character
   * term yields no trigram, and a MATCH expression containing an empty phrase is
   * a syntax error rather than a miss. So trigram input is filtered to terms of
   * at least three characters and skipped entirely when nothing survives.
   */
  _matchExpression(query) {
    let tokens;
    if (this.tokenizer === 'trigram') {
      const chars = [...String(query)];
      const spans = [];
      for (let i = 0; i + 3 <= chars.length; i += 1) spans.push(chars.slice(i, i + 3).join(''));
      tokens = spans;
    } else {
      tokens = T.terms(query);
    }
    const quoted = tokens
      .filter((t) => t && t.length)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    return quoted.length ? quoted.join(' OR ') : '';
  }

  /** Coverage score per candidate id: fraction of query evidence present. */
  _lexicalScores(byId, want) {
    const out = new Map();
    for (const row of byId.values()) {
      const got = this.tokenizer === 'trigram'
        ? T.coverage(want, row.search_text ?? '', { charTier: this.charTier })
        : T.coverage(want, new Set(String(row.search_text ?? '').split(' ').filter(Boolean)), {
          charTier: this.charTier,
        });
      if (got > 0) out.set(row.id, got);
    }
    return out;
  }

  /**
   * Cosine similarity from an embedder, floored at `semanticFloor`.
   *
   * Without an embedder this is 0 and lexical evidence carries the ranking. The
   * floor exists because cosine between unrelated Chinese sentences sits near
   * 0.15-0.25, and unfloored it would credit every memory a little.
   */
  _semantic(memory, query) {
    if (!this.embedder) return 0;
    try {
      const v = this.embedder(query);
      const m = this.embedder(memory.search_text);
      const sim = cosine(v, m);
      return sim >= this.semanticFloor ? sim : 0;
    } catch {
      return 0;
    }
  }

  /**
   * How much of the question's topic the entry *title* accounts for.
   *
   * A hand-written title is the author's own summary of the row, so it is real
   * evidence when the question names the topic with a different verb than the
   * body (「盐吃多了」 vs 「每天盐摄入量」).
   *
   * The gate is on the *question*'s first CJK content segment, not on the
   * title. Gating on the title looked equivalent and was not: generic
   * characters split titles, so 成都旅游攻略 became 成 + 旅游攻略 and slipped
   * through as a one-character title, while 敦煌旅游攻略 - containing no
   * generic character - was rejected whole. The exact match lost its subject
   * score while eight near-miss cities kept theirs.
   *
   * Only the first segment is matched because later segments are scaffolding
   * shared by every first-aid entry (处理 / 怎么办), and a topic of more than
   * four characters is a whole sentence rather than a topic word: 量子计算机
   * 原理 would otherwise share 量 with 力量训练基本原则 and block the web
   * fallback. Characters are compared, not bigrams - 盐 must not be diluted by
   * the bigram it happens to start. Sharing is IDF weighted, so a shared 的 is
   * worthless and a shared 敦煌 is decisive.
   */
  _subjectHit(memory, clean, idf, meanIdf) {
    if (!this.weights.subject || !idf || !memory.subject || !clean) return 0;
    const topic = T.contentSegments(clean).filter(([kind]) => kind === 'cjk').map(([, run]) => run)[0];
    if (!topic || [...topic].length > 4) return 0;

    const want = new Set(topic);
    const have = new Set();
    for (const [, run] of T.contentSegments(this.normalize(String(memory.subject)))) {
      for (const ch of run) have.add(ch);
    }

    let shared = 0;
    let denominator = 0;
    for (const ch of want) {
      const w = idf.get(ch) ?? meanIdf;
      denominator += w;
      if (have.has(ch)) shared += w;
    }
    return denominator > 0 ? shared / denominator : 0;
  }

  _recency(memory) {
    if (!(this.halfLifeDays > 0)) return 1.0;
    const ageDays = Math.max(0, (this.clock() - memory.created_at) / 86400);
    return 0.5 ** (ageDays / this.halfLifeDays);
  }

  /**
   * Inverse document frequency per character in one namespace, plus the mean.
   *
   * Characters are collected through `contentSegments`, so 的/是 and punctuation
   * never enter the table - they are walls, not content. The mean is returned
   * alongside because a character absent from the whole namespace still needs a
   * weight, and falling back to 1.0 would make an unknown character weigh more
   * than a common known one.
   */
  _charIdf(namespace) {
    const cached = this._idfCache.get(namespace);
    if (cached) return cached;

    const rows = this.db.prepare('SELECT search_text FROM items WHERE namespace = ?').all(namespace);
    const n = rows.length;
    const freq = new Map();
    for (const row of rows) {
      const chars = new Set();
      for (const [, run] of T.contentSegments(this.normalize(String(row.search_text ?? '')))) {
        for (const ch of run) chars.add(ch);
      }
      for (const ch of chars) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
    const idf = new Map();
    for (const [ch, f] of freq) idf.set(ch, Math.log((n + 1) / (f + 1)) + 1.0);
    let sum = 0;
    for (const v of idf.values()) sum += v;
    const mean = idf.size ? sum / idf.size : 1.0;
    const entry = { idf, mean };
    this._idfCache.set(namespace, entry);
    return entry;
  }

  /**
   * Render hits as prose, dropping what does not fit.
   *
   * Items are dropped whole, never truncated: half a memory reads like a fact
   * missing its clause, which is worse than not showing it.
   */
  static render(hits, { maxChars = 1800, maxItems = 8 } = {}) {
    const lines = [];
    let used = 0;
    for (const h of hits.slice(0, maxItems)) {
      const subject = h.memory.subject;
      const body = h.memory.body;
      const line = subject ? `- **${subject}**（相关度 ${h.score.toFixed(2)}）：${body}` : `- ${body}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join('\n');
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function reconstruct(db, id) {
  const row = db.prepare('SELECT subject, body FROM items WHERE id = ?').get(id);
  return row ? [row.subject, row.body].filter(Boolean).join(' ') : '';
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const MemoryFactory = { Memory, Recalled, MemoryStore };
export default MemoryStore;
