// Local file search: point it at a folder, then ask questions about what is in it.
//
// The memory store answers "what did I tell you"; this answers "what is in my
// documents". They share one SQLite file and one tokeniser, because a second
// index with a different notion of what a word is would give the same query two
// different answers depending on which box you typed it into.
//
// Extraction is deliberately shallow: text formats are read as text, .docx is
// unzipped and stripped of tags, and anything else is recorded as a file that
// exists but cannot be searched. A PDF parser written here would be worse than
// the reader's own PDF viewer, and pretending otherwise wastes their time.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import * as T from './text.js';
import { fold } from './synonyms.js';
import { utcnow } from './store.js';

/** Readable as plain text. Anything not listed is skipped with a reason. */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.less',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.lua',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.xml', '.svg', '.tex',
]);

/** Unzipped and stripped. Kept separate because extraction differs, not just extension. */
const DOCX_EXTS = new Set(['.docx']);

/** Directories that are never worth walking. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.next', '.nuxt', 'dist', 'build', 'target',
  '.pytest_cache', '.mypy_cache', '.cache', 'tmp', 'temp',
]);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_BYTES = 40 * 1024 * 1024;
const MAX_CHARS = 400_000;
const MAX_FILES = 20_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    root       TEXT    NOT NULL,
    path       TEXT    NOT NULL UNIQUE,
    name       TEXT    NOT NULL,
    ext        TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    mtime      REAL    NOT NULL,
    chars      INTEGER NOT NULL DEFAULT 0,
    body       TEXT    NOT NULL DEFAULT '',
    tokens     TEXT    NOT NULL DEFAULT '',
    name_tokens TEXT   NOT NULL DEFAULT '',
    indexed_at REAL    NOT NULL,
    error      TEXT
);
CREATE INDEX IF NOT EXISTS files_root ON files(root);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    tokens,
    name_tokens,
    content='files',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, tokens, name_tokens) VALUES (new.id, new.tokens, new.name_tokens);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, tokens, name_tokens) VALUES ('delete', old.id, old.tokens, old.name_tokens);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, tokens, name_tokens) VALUES ('delete', old.id, old.tokens, old.name_tokens);
    INSERT INTO files_fts(rowid, tokens, name_tokens) VALUES (new.id, new.tokens, new.name_tokens);
END;
`;

/**
 * Pull the readable text out of a .docx.
 *
 * A .docx is a zip whose `word/document.xml` holds the paragraphs. Node ships
 * deflate but no zip reader, so the central directory is walked by hand - about
 * forty lines, versus a dependency the user would have to install.
 */
function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml');
  if (!xml) return null;
  return xml
    .toString('utf8')
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function zipEntry(buf, wanted) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const data = buf.subarray(start, start + compSize);
      try {
        return method === 0 ? data : inflateRawSync(data);
      } catch {
        return null;
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Can this path be searched? Returns the extraction strategy or null. */
export function strategyFor(file) {
  const ext = extname(file).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  if (DOCX_EXTS.has(ext)) return 'docx';
  return null;
}

export function extract(file) {
  const strategy = strategyFor(file);
  if (!strategy) return { ok: false, reason: 'unsupported' };
  const st = statSync(file);
  if (strategy === 'text' && st.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
  if (strategy === 'docx' && st.size > MAX_DOCX_BYTES) return { ok: false, reason: 'too-large' };

  try {
    if (strategy === 'docx') {
      const text = docxText(readFileSync(file));
      if (text === null) return { ok: false, reason: 'unreadable' };
      return { ok: true, text: text.slice(0, MAX_CHARS) };
    }
    const raw = readFileSync(file, 'utf8');
    // A NUL byte in the first kilobyte is the cheapest reliable sign that this
    // is binary wearing a .txt extension.
    if (raw.slice(0, 1024).includes('\u0000')) return { ok: false, reason: 'binary' };
    return { ok: true, text: raw.slice(0, MAX_CHARS) };
  } catch (error) {
    return { ok: false, reason: error.code ?? 'unreadable' };
  }
}

/** Walk a directory, yielding candidate files. Symlinked loops are cut by `seen`. */
function* walk(root, { maxFiles = MAX_FILES } = {}) {
  const seen = new Set();
  let count = 0;
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        let real;
        try {
          real = statSync(full);
          if (seen.has(`${real.dev}:${real.ino}`)) continue;
          seen.add(`${real.dev}:${real.ino}`);
        } catch {
          continue;
        }
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!strategyFor(full)) continue;
      count += 1;
      if (count > maxFiles) return;
      yield full;
    }
  }
}

export class FileIndex {
  /** @param db the MemoryStore's DatabaseSync handle - one connection, one WAL writer. */
  constructor(db) {
    this.db = db;
    db.exec(SCHEMA);
    this._stByPath = db.prepare('SELECT id, mtime, size FROM files WHERE path = ?');
    this._stUpsert = db.prepare(`
      INSERT INTO files (root, path, name, ext, size, mtime, chars, body, tokens, name_tokens, indexed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        root=excluded.root, name=excluded.name, ext=excluded.ext, size=excluded.size,
        mtime=excluded.mtime, chars=excluded.chars, body=excluded.body, tokens=excluded.tokens,
        name_tokens=excluded.name_tokens, indexed_at=excluded.indexed_at, error=excluded.error
    `);
    this._stDelete = db.prepare('DELETE FROM files WHERE path = ?');
    this._stCount = db.prepare('SELECT count(*) AS n, sum(chars) AS chars FROM files');
    this._stRoots = db.prepare('SELECT root, count(*) AS n, sum(chars) AS chars, max(indexed_at) AS at FROM files GROUP BY root ORDER BY root');
    this._stPathsUnder = db.prepare('SELECT path FROM files WHERE path LIKE ?');
  }

  /**
   * Index one directory tree.
   *
   * Unchanged files (same mtime and size) are left alone: re-reading a
   * thousand-document folder on every start would make the window feel slow for
   * no gain. Files that disappeared are dropped so a stale index cannot answer
   * with a path that no longer opens.
   */
  index(target, { force = false, onProgress = null } = {}) {
    const root = resolve(target);
    if (!existsSync(root)) throw new Error(`目录不存在：${root}`);
    const st = statSync(root);
    const base = st.isDirectory() ? root : resolve(root, '..');
    const files = st.isDirectory() ? [...walk(base)] : [root];

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const skipped = [];
    const seen = new Set();

    for (const file of files) {
      let info;
      try {
        info = statSync(file);
      } catch {
        continue;
      }
      seen.add(file);
      const prev = this._stByPath.get(file);
      if (!force && prev && Math.abs(prev.mtime - info.mtimeMs / 1000) < 1 && prev.size === info.size) {
        unchanged += 1;
        if (onProgress) onProgress({ file, state: 'unchanged' });
        continue;
      }

      const result = extract(file);
      const name = basename(file);
      const ext = extname(file).toLowerCase();
      const text = result.ok ? result.text : '';
      const folded = fold(text);
      const nameFolded = fold(name);

      this._stUpsert.run(
        base,
        file,
        name,
        ext,
        info.size,
        info.mtimeMs / 1000,
        text.length,
        text,
        T.indexText(folded),
        T.indexText(nameFolded),
        utcnow(),
        result.ok ? null : result.reason,
      );
      if (prev) updated += 1;
      else added += 1;
      if (!result.ok) skipped.push({ file, reason: result.reason });
      if (onProgress) onProgress({ file, state: prev ? 'updated' : 'added' });
    }

    let removed = 0;
    if (st.isDirectory()) {
      const prefix = `${base}${sep}%`;
      for (const row of this._stPathsUnder.all(prefix)) {
        if (!seen.has(row.path)) {
          this._stDelete.run(row.path);
          removed += 1;
        }
      }
    }

    return { root: base, scanned: files.length, added, updated, unchanged, removed, skipped: skipped.slice(0, 20), skippedCount: skipped.length };
  }

  stats() {
    const total = this._stCount.get();
    const roots = this._stRoots.all().map((r) => ({ root: r.root, files: r.n, chars: r.chars ?? 0, indexedAt: r.at }));
    return { files: total.n ?? 0, chars: total.chars ?? 0, roots };
  }

  forget(root) {
    const target = resolve(root);
    const rows = this._stPathsUnder.all(`${target}${sep}%`);
    let removed = 0;
    for (const row of rows) {
      this._stDelete.run(row.path);
      removed += 1;
    }
    return removed;
  }

  /**
   * Search indexed files.
   *
   * Ranked by bm25 and then by how much of the query the file covers, because a
   * file that mentions one rare query word once should not outrank the file that
   * is about the question.
   */
  search(query, { limit = 8, root = null } = {}) {
    const clean = T.stripQueryNoise(String(query ?? '')).trim();
    const folded = fold(clean);
    const terms = [...new Set(T.terms(folded))].filter((t) => t.trim());
    if (!terms.length) return [];

    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const want = new Set(terms);
    let rows;
    try {
      rows = this.db
        .prepare(`
          SELECT f.*, bm25(files_fts) AS rank
          FROM files_fts
          JOIN files f ON f.id = files_fts.rowid
          WHERE files_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(match, Math.max(limit * 6, 60));
    } catch {
      return [];
    }

    const scored = [];
    for (const row of rows) {
      if (root && !row.path.startsWith(root)) continue;
      const have = new Set(T.terms(row.tokens));
      let got = 0;
      for (const t of want) if (have.has(t)) got += 1;
      const coverage = got / want.size;
      // bm25 is negative and smaller-is-better; fold it into 0..1 and let
      // coverage carry most of the decision.
      const rankScore = 1 / (1 + Math.max(0, -row.rank));
      scored.push({ row, coverage, score: 0.65 * coverage + 0.35 * rankScore });
    }

    scored.sort((a, b) => b.score - a.score || b.row.chars - a.row.chars);
    return scored.slice(0, limit).map(({ row, score, coverage }) => ({
      id: row.id,
      path: row.path,
      name: row.name,
      ext: row.ext,
      size: row.size,
      chars: row.chars,
      score: Number(score.toFixed(3)),
      coverage: Number(coverage.toFixed(3)),
      snippet: snippet(row.body, want),
      error: row.error,
    }));
  }
}

/**
 * The most useful fragment to show under a result.
 *
 * Picks the window sharing the most query terms with the reader, rather than
 * the first N characters - for a long document the opening paragraph is almost
 * never where the answer is.
 */
export function snippet(body, want, { width = 160 } = {}) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= width) return text;

  let best = 0;
  let bestScore = -1;
  const step = Math.max(20, Math.floor(width / 4));
  for (let start = 0; start < text.length; start += step) {
    const window = text.slice(start, start + width);
    const foldedWindow = fold(window);
    let score = 0;
    for (const term of want) if (foldedWindow.includes(term)) score += term.length;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  // `best` is the start of the *best-scoring window*, which ends at
  // `best + width`. Adding padding on the left must not push that end past the
  // match - the first version shortened the slice to `width` from the padded
  // start and cut the matched words off again.
  const pad = 20;
  const from = Math.max(0, best - pad);
  const to = Math.min(text.length, best + width + pad);
  const body2 = text.slice(from, to);
  return `${from > 0 ? '…' : ''}${body2}${to < text.length ? '…' : ''}`;
}

export default FileIndex;
