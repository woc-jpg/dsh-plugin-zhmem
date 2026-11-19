// Parity tests against the Python reference implementation.
//
// Every expectation here was produced by running the Python original
// (`zhmem.retriever.Retriever.offline`) over the same 84-entry knowledge base,
// so a failure means the JS port has drifted rather than "the answer got
// better". Recall quality itself belongs to the Python test-suite; this file
// only guards behavioural equivalence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeBase } from '../lib/kb.js';
import { Retriever } from '../lib/retriever.js';

// query -> [expected first subject, expected evidence, expected score]
//
// Evidence is the max of the lexical / semantic / subject channels, which is
// also what the web-fallback decision compares against `webThreshold` - so
// pinning it pins the "local answer or go online" behaviour, not just ranking.
const CASES = [
  ['敦煌旅游攻略', '敦煌旅游攻略', 1.0, 0.685],
  ['地震怎么办', '地震避险', 1.0, 1.67],
  ['深蹲正确动作', '深蹲正确动作', 1.0, 0.67],
  ['每天盐摄入量', '每天盐摄入量', 1.0, 0.655],
  ['烫伤急救', '烫伤烧伤急救', 1.0, 1.67],
  ['失眠怎么改善', '改善睡眠的方法', 1.0, 1.212],
  ['咖啡怎么喝', '改善睡眠的方法', 1.0, 0.685],
  ['膝盖疼', '跑步入门与配速', 1.0, 0.67],
  ['血压多少算高', '正常血压范围', 1.0, 1.43],
  ['孩子发烧了怎么办', '发烧怎么处理', 0.446, 0.816],
];

// Queries whose evidence is *below* webThreshold on purpose: they must still
// hit locally but must also trigger the web fallback. Keeping them here stops a
// future "improvement" to subject matching from quietly starving the online path.
const WEAK_CASES = [['python怎么安装', 0.408]];

function evidenceOf(hit) {
  const p = hit.parts;
  return Math.max(p.lexical ?? 0, p.semantic ?? 0, p.subject ?? 0);
}

// The retriever's `ask` is async, so the store must outlive the promise. An
// earlier synchronous try/finally closed the database before `ask` resolved and
// every case failed with an unrelated "database is closed" error.
async function withRetriever(fn) {
  const kb = new KnowledgeBase(':memory:');
  const retriever = new Retriever({ store: kb.store, offline: true });
  try {
    return await fn(kb, retriever);
  } finally {
    kb.close();
  }
}

test('knowledge base loads all 84 built-in entries', () => {
  withRetriever((kb) => {
    assert.deepEqual(kb.counts, { daily: 36, travel: 24, fitness: 24 });
    assert.equal(kb.store.count(), 84);
  });
});

for (const [query, subject, evidence, score] of CASES) {
  test(`parity: ${query}`, () => {
    withRetriever(async (kb, retriever) => {
      const answer = await retriever.ask(query, { web: false, images: false });
      assert.ok(answer.local.length, `${query} produced no local hit at all`);
      const top = answer.local[0];
      assert.equal(top.memory.subject, subject, `${query} ranked the wrong entry first`);
      assert.equal(evidenceOf(top).toFixed(3), evidence.toFixed(3), `${query} evidence drifted`);
      assert.equal(top.score.toFixed(3), score.toFixed(3), `${query} score drifted`);
    });
  });
}

for (const [query, evidence] of WEAK_CASES) {
  test(`weak local evidence stays below the web threshold: ${query}`, () => {
    withRetriever(async (kb, retriever) => {
      const answer = await retriever.ask(query, { web: false, images: false });
      assert.ok(answer.local.length, `${query} should still return something locally`);
      const ev = evidenceOf(answer.local[0]);
      assert.ok(
        ev < retriever.webThreshold,
        `${query} evidence ${ev} must stay under ${retriever.webThreshold} or the web fallback never fires`,
      );
      assert.equal(ev.toFixed(3), evidence.toFixed(3), `${query} evidence drifted`);
    });
  });
}

test('subject channel does not fire on long topic phrases', () => {
  withRetriever(async (kb, retriever) => {
    // 量子计算机原理 is a sentence, not a topic word: only its first CJK
    // content segment (6 chars) is considered, so it exceeds the 4-char gate and
    // the title channel stays 0 instead of matching 量 against 力量训练.
    const answer = await retriever.ask('量子计算机原理', { web: false, images: false });
    for (const hit of answer.local) {
      assert.equal(hit.parts.subject, 0, `subject charged ${hit.memory.subject} for a sentence-length topic`);
    }
  });
});
