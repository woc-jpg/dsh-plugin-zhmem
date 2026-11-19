// Answer assembly: local knowledge first, web only when local is weak.
//
// Ported from zhmem/retriever.py. One number in here is worth more explanation
// than the rest of the file.

import { WebSearch, ImageSearch } from './web.js';

/**
 * How much local evidence is enough to skip the web.
 *
 * The comparison is against `max(lexical, semantic, subject)` - the *evidence*
 * - never against the final score. Score includes recency and salience, which
 * sum to as much as 0.25 for a memory written one second ago containing nothing
 * relevant: measured live, 「python怎么安装」 scored 0.643 against a Xi'an travel
 * entry and skipped the web entirely. The same query's evidence is 0.408, below
 * 0.45, so it goes online as it should. Genuine topics measure >= 0.45;
 * unrelated questions <= 0.41.
 */
export const WEB_THRESHOLD = 0.45;

export class Answer {
  constructor({ query, local = [], web = [], images = [], usedWeb = false, reason = '' }) {
    this.query = query;
    this.local = local;
    this.web = web;
    this.images = images;
    this.usedWeb = usedWeb;
    this.reason = reason;
  }

  /** The namespaces an answer drew on, for citation. */
  localCitations() {
    return this.local.map((h) => ({
      id: h.memory.meta?.id ?? String(h.memory.id),
      namespace: h.memory.namespace,
      title: h.memory.subject,
      score: Number(h.score.toFixed(3)),
    }));
  }

  render({ images = true, limit = 5 } = {}) {
    const blocks = [];

    if (this.local.length) {
      const lines = this.local
        .slice(0, limit)
        .map((h) => (h.memory.subject
          ? `- **${h.memory.subject}**（相关度 ${h.score.toFixed(2)}）：${h.memory.body}`
          : `- ${h.memory.body}`));
      blocks.push(`### 本地知识库\n\n${lines.join('\n')}`);
    }

    if (this.web.length) {
      const lines = this.web.map((r) => `- [${r.title}](${r.url})${r.snippet ? `\n  ${r.snippet}` : ''}`);
      blocks.push(`### 网络资料\n\n${lines.join('\n')}`);
    }

    if (images && this.images.length) {
      const lines = this.images.map((r) => `- ![${r.title}](${r.url})${r.page ? `（[来源](${r.page})）` : ''}`);
      blocks.push(`### 相关图片\n\n${lines.join('\n')}`);
    }

    if (!blocks.length) {
      const why = this.reason ? `（${this.reason}）` : '';
      return `没有找到相关内容${why}。可以换个说法，或者把这条信息存进记忆库。`;
    }
    return blocks.join('\n\n');
  }
}

export class Retriever {
  constructor(options = {}) {
    const {
      store = null,
      // Namespaces searched for local answers. Order matters only for ties.
      namespaces = ['daily', 'travel', 'fitness', 'mine'],
      // 'note' memories are the user's own; 'kb' and 'kb-user' are curated.
      kinds = null,
      web = null,
      images = null,
      offline = false,
      webThreshold = WEB_THRESHOLD,
      localLimit = 3,
      webLimit = 5,
      imagesLimit = 3,
      clock = null,
    } = options;

    if (!store) throw new Error('Retriever requires a store');
    this.store = store;
    this.namespaces = namespaces;
    this.kinds = kinds;
    this.web = web ?? new WebSearch(null, { offline });
    this.images = images ?? new ImageSearch(null, { offline });
    this.offline = offline;
    this.webThreshold = webThreshold;
    this.localLimit = localLimit;
    this.webLimit = webLimit;
    this.imagesLimit = imagesLimit;
    this.clock = clock;
  }

  static offline(options = {}) {
    return new Retriever({ ...options, offline: true, webThreshold: null });
  }

  /**
   * Search every configured namespace and merge.
   *
   * Each namespace is scored separately, then merged: pooling them into one
   * store with a namespace filter would let the 84-entry knowledge base's IDF
   * statistics drown out a user's five personal notes.
   */
  _local(query, recent = []) {
    const merged = new Map();
    for (const ns of this.namespaces) {
      for (const hit of this.store.recall(ns, query, {
        limit: this.localLimit,
        recent,
        kinds: this.kinds,
      })) {
        const prev = merged.get(hit.memory.id);
        if (!prev || hit.score > prev.score) merged.set(hit.memory.id, hit);
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, this.localLimit);
  }

  async ask(query, options = {}) {
    const {
      recent = [],
      web = null,
      images = true,
      limit = 5,
      namespaces = null,
    } = options;

    const search = namespaces ? { ...this, namespaces } : this;
    const local = search._local(query, recent);

    // The evidence channels that mean "we found the topic", in the same order
    // the store scores them. `subject` only counts when the store was built with
    // subject_bonus, and `parts.subject` is 0 otherwise.
    const best = local.length
      ? Math.max(
        local[0].parts.lexical ?? 0,
        local[0].parts.semantic ?? 0,
        local[0].parts.subject ?? 0,
      )
      : 0;

    const useWeb = web !== null
      ? web
      : (this.webThreshold !== null && (!local.length || best < this.webThreshold));

    let webResults = [];
    let imageResults = [];
    let reason = '';

    if (useWeb) {
      if (this.offline) {
        reason = '离线模式，没有联网';
      } else {
        webResults = await this.web.search(query, { limit: this.webLimit });
        if (!webResults.length) reason = '本地没有匹配，联网也没取到结果';
      }
    }

    if (images) {
      const imageQuery = this._imageQuery(query, local);
      if (imageQuery) imageResults = await this.images.search(imageQuery, { limit: this.imagesLimit });
    }

    return new Answer({
      query,
      local,
      web: webResults,
      images: imageResults,
      usedWeb: useWeb,
      reason,
    });
  }

  /**
   * Query for the image search.
   *
   * A matched entry carries a hand-written English `image_query` ("earthquake
   * safety drop cover") that beats the user's Chinese question, because Commons
   * indexes English descriptions. Falls back to the raw query when nothing local
   * matched - the query itself is then the best description available.
   */
  _imageQuery(query, local) {
    for (const hit of local) {
      const q = hit.memory.meta?.image_query;
      if (q) return q;
    }
    return query?.trim() ? query.trim() : '';
  }

  close() {
    // The store is owned by the caller; closing it here would pull the database
    // out from under a second retriever sharing the same file.
  }
}

export default Retriever;
