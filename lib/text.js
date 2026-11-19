// Tokenisation and evidence scoring for Chinese retrieval over short memories.
//
// This is a straight port of zhmem/text.py. The comment block below is the
// original rationale, kept because every rule here came out of a measured
// failure and the numbers are the only reason to believe them.
//
// * SQLite's `trigram` tokeniser cannot index a two-character word - a trigram
//   is three characters, so 「普洱」 produces no token the index holds.
//   Indexing CJK text as space-separated unigrams plus bigrams under `unicode61`
//   fixes that.
// * BM25 is degenerate on small corpora: a term in 2 of 4 rows has IDF 0 and
//   `bm25()` returns `-0.0000` for every row, so recency and salience decide the
//   ranking. `coverage()` is absolute and interpretable instead.
// * Generic characters must be removed as *phrases* where possible. Stripping
//   the single character 日 breaks 「日本」 into 「本」, and stripping 上/下 breaks
//   「上周」「下午」 - each time a real topic word quietly disappears.

const CJK_RANGES = [[0x4e00, 0x9fff], [0x3400, 0x4dbf], [0xf900, 0xfaff]];

const WORD = 1.0;
const CHAR = 0.2;

// Pure function words and symptom words only. Content-bearing characters stay,
// even when they double as a date word: 上 builds 上周, 下 builds 下午, 日 builds
// 日本. Removing them is a regression that shows up as a lower score on queries
// that plainly match.
export const GENERIC_CHARS = new Set(
  [
    '的了是在和就都也还有没不很太会能要想说给对从咱这哪个些什',
    '么怎样吧呢吗啊呀嘛哦',
    '疼痛病累药医院',
  ]
    .join('')
    .split(''),
);

// Question scaffolding and temporal deictics, removed as whole phrases. A single
// character stripped here would take a topic with it (日→日本, 次→上次).
const JUNK_PHRASES = [
  '记不记得', '还记得', '是不是', '有没有', '好不好', '行不行', '要不要',
  '怎么办', '怎么样', '怎样', '咋办', '咋样', '如何', '为什么', '是什么',
  '什么', '哪里', '哪个', '哪些', '哪儿', '多少', '几点', '多大',
  '今天', '昨天', '明天', '那天', '上次', '那次', '这次', '每次', '下次',
  '刚才', '以后', '以前',
];

const PUNCT = /[?？!！。,.，、;；:："'“”‘’()（）[\]【】<>《》\s]+/g;

export function isCjk(ch) {
  const cp = ch.codePointAt(0);
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * Maximal runs of CJK content chars, plus whole Latin/number words.
 *
 * Generic characters and punctuation are walls, so no generated bigram spans
 * one. Mixed text (「用 sqlite3 存的」) is naturally kept apart.
 */
export function contentSegments(text) {
  const out = [];
  let buf = [];
  let kind = null;

  const flush = () => {
    if (buf.length && kind) out.push([kind, buf.join('')]);
    buf = [];
  };

  for (const ch of String(text ?? '')) {
    let thisKind = null;
    if (isCjk(ch) && !GENERIC_CHARS.has(ch)) thisKind = 'cjk';
    else if (/[0-9A-Za-z]/.test(ch)) thisKind = 'latin';

    if (thisKind !== kind) {
      flush();
      kind = thisKind;
    }
    if (thisKind) buf.push(thisKind === 'latin' ? ch.toLowerCase() : ch);
  }
  flush();
  return out;
}

/** Unigrams, bigrams and Latin words, in order of first appearance. */
export function terms(text) {
  const seen = new Set();
  const out = [];
  for (const [kind, run] of contentSegments(text)) {
    const candidates = kind === 'latin' ? [run] : [
      ...run.split(''),
      ...Array.from({ length: Math.max(0, run.length - 1) }, (_, i) => run.slice(i, i + 2)),
    ];
    for (const tok of candidates) {
      if (tok && !seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

/** Space-separated terms - `unicode61` would treat Han text as one token. */
export function indexText(text) {
  return terms(text).join(' ');
}

/**
 * Remove interrogative scaffolding and deictics, keeping topic words.
 *
 * The Python original returns the query unchanged when stripping leaves nothing.
 * That fallback is load-bearing: 「上次」「怎么办」 alone still carry intent.
 */
export function stripQueryNoise(query) {
  let out = String(query ?? '');
  for (const phrase of JUNK_PHRASES) out = out.split(phrase).join(' ');
  out = out.replace(PUNCT, ' ').trim();
  out = out.split(/\s+/).filter(Boolean).join(' ');
  return out || String(query ?? '');
}

/**
 * Whether an utterance names something, after removing question scaffolding.
 *
 * 「那次怎么样」 and 「她叫什么」 have no topic on their own: only the previous
 * turn says what 那次 / 她 refers to. A two-character-or-longer content segment
 * is the minimum that can be searched without guessing.
 */
export function hasTopic(text) {
  for (const [kind, run] of contentSegments(stripQueryNoise(text))) {
    if (kind === 'latin' && run.length >= 2) return true;
    if (run.length >= 2) return true;
  }
  return false;
}

/**
 * Weighted terms of a query: bigrams and Latin words 1.0, unigrams 0.2.
 *
 * Only *isolated* characters - a content character with no content neighbour -
 * are given unigram weight. A character inside a word (学 in 力学, 家 in 老家)
 * is not evidence on its own: 「量子力学」 and 「小学二年级」 share 学, and at
 * 0.2 it beat genuine matches on nine negative queries. A character that stands
 * alone (喝 in 咖啡怎么喝) is different - it is the whole topic word.
 */
export function queryTerms(query) {
  const weights = new Map();
  for (const [kind, run] of contentSegments(stripQueryNoise(query))) {
    if (kind === 'latin') {
      weights.set(run, WORD);
      continue;
    }
    for (let i = 0; i < run.length; i += 1) {
      const before = i > 0 ? run[i - 1] : '';
      const after = i + 1 < run.length ? run[i + 1] : '';
      if (!before && !after && !weights.has(run[i])) weights.set(run[i], WORD);
      const bigram = run.slice(i, i + 2);
      if (bigram.length === 2) weights.set(bigram, WORD);
    }
  }
  return weights;
}

/**
 * Fraction of the query's evidence that `have` contains, 0..1.
 *
 * `have` is a token Set (bigram index) or a raw string (trigram index, where a
 * match can only mean substring).
 *
 * Multi-character matches first; unigrams are ignored entirely when any word
 * matched, because counting 膝 and 痛 on top of 膝盖 inflates weak overlap.
 *
 * The character tier applies only when no word matched *this candidate*. A query
 * like 「咖啡怎么喝」 shares no bigram with 「喝美式不加糖」 but must still find
 * it on the character 喝. Absolute, never min-max: min-max promotes the
 * least-bad candidate in a set of bad ones to a perfect 1.0.
 */
export function coverage(want, have, { charTier = true } = {}) {
  const isSet = have instanceof Set;
  const contains = isSet ? (t) => have.has(t) : (t) => String(have).includes(t);

  const words = new Map();
  for (const [t, w] of want) if ([...t].length > 1) words.set(t, w);

  if (!charTier) {
    // With the weak character tier disabled, an *isolated* single character is
    // still primary evidence - queryTerms already gave it full WORD weight
    // ("喝" in 咖啡怎么喝). Only word-internal characters get no weight and can
    // never reach `want`. Treat those isolated chars as words here; otherwise a
    // one-character topic query scores 0 for every candidate.
    for (const [t, w] of want) if ([...t].length === 1) words.set(t, w);
  }

  if (words.size) {
    let got = 0;
    let total = 0;
    for (const [t, w] of words) {
      total += w;
      if (contains(t)) got += w;
    }
    if (got) return got / total;
  }

  if (!charTier || !want.size) return 0;

  let got = 0;
  let total = 0;
  for (const [t, w] of want) {
    total += w;
    if (contains(t)) got += w;
  }
  return got ? Math.min(0.25, (0.5 * got) / total) : 0;
}
