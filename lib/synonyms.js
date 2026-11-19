// Synonym folding, applied to the index and the query by the same function.
//
// The failure this module exists to prevent is subtle and easy to ship: fold
// synonyms on the query side only, and recall *drops*. A memory stored as
// 「最近睡不着」 gets indexed verbatim; the query 「老人家失眠」 gets rewritten to
// its canonical form; FTS5 then finds nothing, and the vector score measured
// 0.169, below any usable floor. Nothing raises, nothing logs - the memory is
// simply unreachable.
//
// So `fold()` is the single entry point and the store calls it on both sides.
// That is also why folding lives on the store rather than at each call site:
// one place to be wrong, one place to fix.
//
// A real embedding model does not need this (it already knows 失眠 ≈ 睡不着),
// which is why folding is opt-in per store rather than baked into tokenisation.

/**
 * Build variant -> canonical from [canonical, alias, ...variants].
 *
 * Every canonical form maps to itself. Without that, a second pass over the
 * output would fold a canonical word's *substring*: 拉肚子 contains 肚子, so it
 * became 拉腹部 - a word that exists in no dictionary and matches nothing.
 */
function pairs(groups) {
  const table = new Map();
  for (const [canonical, alias, ...variants] of groups) {
    table.set(canonical, canonical);
    table.set(alias, canonical);
    for (const v of variants) table.set(v, canonical);
  }
  return table;
}

// Groups are semantic, not thesaural: each one is a set of words a family member
// would plausibly use for the same fact on different days.
const BODY = pairs([
  ['膝盖', '膝关节', '膝'],
  ['肚子', '腹部', '小腹', '肠胃', '胃'],
  ['头', '脑袋', '头部'],
  ['牙', '牙齿', '牙床'],
  ['腰椎', '腰', '腰背'],
]);

const PAIN = pairs([['痛', '疼', '不舒服', '不适', '难受']]);

const FEELING = pairs([
  ['失眠', '睡不着', '睡眠不好', '睡不好', '无法入睡', '睡觉', '入睡'],
  ['高兴', '开心', '愉快', '快乐', '心情好'],
  ['难过', '伤心', '低落', '心情不好'],
  ['累', '疲劳', '乏力', '没力气'],
]);

const DAILY = pairs([
  ['散步', '走路', '遛弯', '走一走'],
  ['就诊', '看病', '去医院', '挂号', '复诊'],
]);

const FAMILY = pairs([
  ['孩子', '儿子', '女儿', '娃'],
  ['老伴', '伴侣', '丈夫', '妻子', '老公', '老婆'],
]);

// Everyday co-reference no character-level scorer can bridge: 茶 is the family
// name for 普洱/浓茶, and a blood-sugar question is about 糖尿病. Both were
// measured as total misses (coverage 0.0) on the eval set.
const DRINK = pairs([
  ['茶', '茶叶', '普洱', '浓茶', '红茶', '绿茶'],
  ['咖啡', '美式', '拿铁', '意式', 'espresso'],
]);

const CONDITION = pairs([['糖尿病', '血糖', '血糖高', '糖尿', '高血糖']]);

export const CANONICAL = new Map([
  ...BODY, ...PAIN, ...FEELING, ...DAILY, ...FAMILY, ...DRINK, ...CONDITION,
]);

const MAX_LEN = Math.max(...[...CANONICAL.keys()].map((k) => [...k].length));

export function longestMatchLen() {
  return MAX_LEN;
}

/**
 * Replace known variants with canonical forms, left to right.
 *
 * Single pass taking the longest match at each position, because sequential
 * replacement re-folds its own output: with 肚子->腹部 in the table, replacing
 * 肚子 first turns 拉肚子 into 拉腹部 and the correct rule never fires.
 *
 * Indexing by code point (not UTF-16 unit) so a surrogate-pair character can
 * never be split in half.
 */
export function fold(text) {
  if (!text) return text;
  const chars = [...String(text)];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    let matched = false;
    const ceiling = Math.min(MAX_LEN, chars.length - i);
    for (let size = ceiling; size >= 1; size -= 1) {
      const chunk = chars.slice(i, i + size).join('');
      const canonical = CANONICAL.get(chunk);
      if (canonical !== undefined) {
        out.push(canonical);
        i += size;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(chars[i]);
      i += 1;
    }
  }
  return out.join('');
}

export default fold;
