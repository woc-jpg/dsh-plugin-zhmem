// Built-in knowledge base: 84 entries in three JSON files shipped with the plugin.
//
// The knowledge base is not a special type - it is a MemoryStore seeded from
// JSON, with `subject_bonus` turned on because entry titles are curated rather
// than user-typed. That is why a user's own knowledge file drops into the same
// path: same loader, different namespace.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from './store.js';
import * as T from './text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, '..', 'data');

export const BUILTIN_NAMESPACES = ['daily', 'travel', 'fitness'];

export class KBEntry {
  constructor({ id, namespace, title, body, tags = [], image_query = '', salience = 0.5 }) {
    this.id = id;
    this.namespace = namespace;
    this.title = title;
    this.body = body;
    this.tags = tags;
    this.image_query = image_query;
    this.salience = salience;
  }

  get search_text() {
    return [this.title, this.body, ...this.tags].filter(Boolean).join(' ');
  }
}

/** Read one namespace file. Accepts a bare array or `{ "entries": [...] }`. */
export function readNamespaceFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.entries ?? []);
}

export function loadEntries(namespaces = BUILTIN_NAMESPACES, options = {}) {
  const dir = options.dir ?? DATA_DIR;
  const out = new Map();
  for (const ns of namespaces) {
    const file = join(dir, `${ns}.json`);
    if (!existsSync(file)) continue;
    for (const item of readNamespaceFile(file)) {
      const eid = item.id ?? item.title;
      const key = `${ns}/${eid}`;
      if (out.has(key)) throw new Error(`duplicate knowledge-base id: ${key}`);
      out.set(key, new KBEntry({ ...item, namespace: ns }));
    }
  }
  return [...out.values()];
}

/**
 * Seed a store from entries.
 *
 * `search_text` is passed through so tags stay in the index - the store would
 * otherwise derive it from subject+body and quietly drop them.
 */
export function install(store, namespaces = BUILTIN_NAMESPACES, options = {}) {
  const counts = {};
  for (const e of loadEntries(namespaces, options)) {
    store.add(e.namespace, e.body, {
      kind: 'kb',
      subject: e.title,
      salience: e.salience,
      meta: { id: e.id, image_query: e.image_query, tags: e.tags },
      searchText: e.search_text,
    });
    counts[e.namespace] = (counts[e.namespace] ?? 0) + 1;
  }
  return counts;
}

/**
 * A store preloaded with the built-in knowledge base.
 *
 * `subject_bonus: 1.0` is set here, not in MemoryStore. A user's personal store
 * keeps the default 0 because an empty subject must not count as evidence.
 */
export class KnowledgeBase {
  constructor(path = ':memory:', options = {}) {
    const { namespaces = BUILTIN_NAMESPACES, dir = DATA_DIR, ...storeOptions } = options;
    this.store = new MemoryStore(path, { subjectBonus: 1.0, ...storeOptions });
    this.counts = install(this.store, namespaces, { dir });
    this.namespaces = namespaces;
  }

  /** Look up one entry by its JSON id, across the loaded namespaces. */
  entry(id) {
    for (const memory of this.store.list(null, { limit: 100000, kind: 'kb' })) {
      if (memory.meta?.id === id) {
        return new KBEntry({
          id,
          namespace: memory.namespace,
          title: memory.subject,
          body: memory.body,
          tags: memory.meta.tags ?? [],
          image_query: memory.meta.image_query ?? '',
          salience: memory.salience,
        });
      }
    }
    return null;
  }

  get size() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  close() {
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// User-supplied knowledge
// ---------------------------------------------------------------------------

/**
 * Validate a user knowledge file before it is imported.
 *
 * This runs before anything touches the store so a bad file produces a list of
 * concrete objections instead of a half-imported namespace. Every problem is
 * reported with its index and field, because "invalid JSON" alone tells the user
 * nothing about which of their 200 entries broke.
 */
export function validateKnowledge(entries) {
  const problems = [];
  if (!Array.isArray(entries)) {
    return { ok: false, problems: ['顶层必须是数组，或形如 {"entries": [...]} 的对象'] };
  }
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `第 ${i + 1} 条`;
    if (!e || typeof e !== 'object') {
      problems.push(`${at}：不是对象`);
      return;
    }
    if (typeof e.title !== 'string' || !e.title.trim()) problems.push(`${at}：缺少 title（标题，检索时作为主题词）`);
    if (typeof e.body !== 'string' || !e.body.trim()) problems.push(`${at}：缺少 body（正文内容）`);
    if (e.tags !== undefined && !Array.isArray(e.tags)) problems.push(`${at}：tags 必须是字符串数组`);
    if (e.salience !== undefined) {
      const s = Number(e.salience);
      if (!Number.isFinite(s) || s < 0 || s > 1) problems.push(`${at}：salience 必须是 0 到 1 之间的数字`);
    }
    if (e.id !== undefined) {
      const key = String(e.id);
      if (seen.has(key)) problems.push(`${at}：id「${key}」与前面的条目重复`);
      seen.add(key);
    }
    if (typeof e.body === 'string' && e.body.length > 4000) {
      problems.push(`${at}：正文 ${e.body.length} 字过长，建议拆成多条（单条 4000 字以内召回更准）`);
    }
  });
  return { ok: problems.length === 0, problems };
}

/**
 * Import a user's knowledge file into their own namespace of the live store.
 *
 * Default `namespace: "mine"`. Entries keep their own ids in `meta.id` so
 * re-importing the same file updates rather than duplicates: the match key is
 * (namespace, meta.id), and an entry with no id falls back to its title.
 */
export function importKnowledge(store, entries, options = {}) {
  const { namespace = 'mine', replace = true } = options;
  const check = validateKnowledge(entries);
  if (!check.ok) {
    const err = new Error(`知识文件有问题，未导入：\n${check.problems.slice(0, 10).join('\n')}`);
    err.problems = check.problems;
    throw err;
  }

  if (replace) {
    // Remove only entries this importer owns: kind 'kb-user'. Anything the user
    // saved as a personal memory stays.
    for (const memory of store.list(namespace, { limit: 100000, kind: 'kb-user' })) {
      store.forget(memory.id);
    }
  }

  const counts = { added: 0, updated: 0 };
  const byKey = new Map();
  for (const memory of store.list(namespace, { limit: 100000, kind: 'kb-user' })) {
    byKey.set(memory.meta?.id ?? memory.subject, memory);
  }

  for (const e of entries) {
    const id = String(e.id ?? e.title);
    const payload = {
      kind: 'kb-user',
      subject: e.title,
      salience: Number.isFinite(Number(e.salience)) ? Number(e.salience) : 0.6,
      meta: { id, image_query: e.image_query ?? '', tags: e.tags ?? [], source: 'user-import' },
      searchText: new KBEntry({ ...e, namespace, tags: e.tags ?? [] }).search_text,
    };
    const existing = byKey.get(id);
    if (existing) {
      store.forget(existing.id);
      counts.updated += 1;
    } else {
      counts.added += 1;
    }
    store.add(namespace, e.body, payload);
  }

  return { namespace, ...counts, total: entries.length };
}

/** Where a user's own knowledge files live on disk. */
export function userKnowledgeDir() {
  const db = process.env.ZHMEM_DB;
  const base = db ? dirname(db) : join(homedir(), '.workbuddy');
  return join(base, 'zhmem-knowledge');
}

export function ensureUserKnowledgeDir() {
  const dir = userKnowledgeDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a starter template the user can edit.
 *
 * Shipped as a real importable file rather than documentation, because the
 * fastest path to "my own knowledge works" is filling in a file that already
 * loads.
 */
export function writeTemplate(dir = ensureUserKnowledgeDir()) {
  const file = join(dir, 'my-knowledge.json');
  const sample = [
    {
      id: 'my-001',
      title: '家里的路由器密码',
      body: '路由器管理地址 192.168.1.1，管理员账号 admin，密码写在书房抽屉的便签上。',
      tags: ['路由器', '密码', 'wifi'],
      salience: 0.6,
    },
    {
      id: 'my-002',
      title: '常吃的降压药',
      body: '每天早上饭后一片，药盒在客厅电视柜第二格，复诊时带上药盒给医生看。',
      tags: ['降压药', '用药', '复诊'],
      salience: 0.8,
    },
  ];
  writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
  return file;
}

/** Summary of what the store currently holds, for the stats tool. */
export function describe(store) {
  const counts = store.counts();
  const kb = Object.entries(counts)
    .filter(([ns]) => BUILTIN_NAMESPACES.includes(ns))
    .reduce((a, [, n]) => a + n, 0);
  const own = counts.mine ?? 0;
  const personal = Object.entries(counts)
    .filter(([ns]) => !BUILTIN_NAMESPACES.includes(ns) && ns !== 'mine')
    .reduce((a, [, n]) => a + n, 0);
  return { counts, builtinKnowledge: kb, importedKnowledge: own, personalMemories: personal };
}

export { T };
