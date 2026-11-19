import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileIndex, extract, strategyFor, snippet } from '../lib/files.js';
import { MemoryStore } from '../lib/store.js';

function withIndex(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zhmem-files-'));
  const store = new MemoryStore(join(dir, 'test.db'));
  const index = new FileIndex(store.db);
  try {
    return fn({ dir, index, store });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('strategyFor recognises text and docx, rejects the rest', () => {
  assert.equal(strategyFor('a.md'), 'text');
  assert.equal(strategyFor('a.TXT'), 'text');
  assert.equal(strategyFor('a.docx'), 'docx');
  assert.equal(strategyFor('a.pdf'), null);
  assert.equal(strategyFor('a.exe'), null);
});

test('extract reads text files and flags binaries', () => {
  withIndex(({ dir }) => {
    const txt = join(dir, 'note.md');
    writeFileSync(txt, '膝盖疼的时候先别跑，换成游泳。');
    const ok = extract(txt);
    assert.equal(ok.ok, true);
    assert.match(ok.text, /游泳/);

    const bin = join(dir, 'fake.txt');
    writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
    assert.deepEqual(extract(bin), { ok: false, reason: 'binary' });
  });
});

test('index walks a tree and skips noise directories', () => {
  withIndex(({ dir, index }) => {
    mkdirSync(join(dir, 'notes'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'notes', 'a.md'), '敦煌的莫高窟要提前预约。');
    writeFileSync(join(dir, 'notes', 'b.txt'), '每天盐摄入量不超过五克。');
    writeFileSync(join(dir, 'node_modules', 'c.js'), 'should not be indexed');
    writeFileSync(join(dir, 'photo.pdf'), 'not readable');

    const result = index.index(dir);
    assert.equal(result.added, 2);
    assert.equal(index.stats().files, 2);
  });
});

test('search finds a document by a word inside it', () => {
  withIndex(({ dir, index }) => {
    writeFileSync(join(dir, 'travel.md'), '敦煌旅游攻略：莫高窟、鸣沙山、月牙泉，三天足够。');
    writeFileSync(join(dir, 'fitness.md'), '深蹲的时候膝盖不要内扣，重心放在脚后跟。');
    index.index(dir);

    const hits = index.search('莫高窟');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'travel.md');
    assert.match(hits[0].snippet, /莫高窟/);
  });
});

test('search prefers the file that covers more of the query', () => {
  withIndex(({ dir, index }) => {
    writeFileSync(join(dir, 'one.md'), '敦煌。');
    writeFileSync(join(dir, 'two.md'), '敦煌旅游攻略，莫高窟和鸣沙山都值得去，最好安排三天。');
    index.index(dir);

    const hits = index.search('敦煌旅游攻略');
    assert.equal(hits[0].name, 'two.md');
  });
});

test('unchanged files are not re-read on the second pass', () => {
  withIndex(({ dir, index }) => {
    writeFileSync(join(dir, 'a.md'), '一些内容');
    assert.equal(index.index(dir).added, 1);
    const second = index.index(dir);
    assert.equal(second.added, 0);
    assert.equal(second.unchanged, 1);
  });
});

test('a deleted file leaves the index', () => {
  withIndex(({ dir, index }) => {
    const file = join(dir, 'gone.md');
    writeFileSync(file, '马上要被删掉');
    index.index(dir);
    assert.equal(index.stats().files, 1);
    rmSync(file);
    const result = index.index(dir);
    assert.equal(result.removed, 1);
    assert.equal(index.stats().files, 0);
  });
});

test('forget drops a whole root', () => {
  withIndex(({ dir, index }) => {
    writeFileSync(join(dir, 'a.md'), '内容甲');
    writeFileSync(join(dir, 'b.md'), '内容乙');
    index.index(dir);
    assert.equal(index.forget(dir), 2);
    assert.equal(index.stats().files, 0);
  });
});

test('snippet centres on the query instead of the file start', () => {
  const body = `${'铺垫'.repeat(200)}这里提到莫高窟${'收尾'.repeat(200)}`;
  const out = snippet(body, new Set(['莫高窟']), { width: 60 });
  assert.match(out, /莫高窟/);
  assert.ok(out.startsWith('…'));
});

test('search on an empty index returns nothing rather than throwing', () => {
  withIndex(({ index }) => {
    assert.deepEqual(index.search('任何东西'), []);
  });
});

test('an empty query returns nothing', () => {
  withIndex(({ dir, index }) => {
    writeFileSync(join(dir, 'a.md'), '内容');
    index.index(dir);
    assert.deepEqual(index.search('   '), []);
  });
});
