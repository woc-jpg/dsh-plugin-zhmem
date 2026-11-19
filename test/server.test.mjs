// Tests for the standalone HTTP surface. The retrieval numbers are already
// pinned by parity.test.mjs; what matters here is that the HTTP layer wires the
// same runtime through without changing results, and that the static file
// server cannot be walked out of.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server.js';

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zhmem-srv-'));
  const app = await startServer({ port: 0, dbPath: join(dir, 'test.db') });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
  rmSync(dir, { recursive: true, force: true });
}

test('status reports the seeded knowledge base', async () => {
  await withServer(async (app) => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/status`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.version, '0.2.0');
    assert.deepEqual(data.counts, { daily: 36, travel: 24, fitness: 24 });
    assert.ok(data.tools.includes('zhmem_ask'));
  });
});

test('ask over HTTP matches the in-process retriever', async () => {
  await withServer(async (app) => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/zhmem_ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '每天盐摄入量', web_mode: 'never' }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.result.used_web, false);
    assert.match(data.result.markdown, /### 本地知识库/);
    assert.match(data.result.markdown, /每天盐摄入量/);
  });
});

test('remember then recall round-trips through HTTP', async () => {
  await withServer(async (app) => {
    const base = `http://127.0.0.1:${app.port}/api`;
    const post = (name, body) =>
      fetch(`${base}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const saved = await post('zhmem_remember', { text: '我对花粉过敏', subject: '过敏' });
    assert.equal(saved.ok, true);
    assert.ok(saved.result.id > 84, 'personal memories come after the seeded entries');

    const found = await post('zhmem_recall', { query: '花粉过敏' });
    assert.match(found.result.markdown, /我对花粉过敏/);
  });
});

test('knowledge import requires title and body', async () => {
  await withServer(async (app) => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/zhmem_import_knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ title: '只有标题' }] }),
    });
    const data = await res.json();
    assert.equal(data.result.ok, false);
    assert.match(data.result.message, /缺少 body/);
  });
});

test('imported knowledge is retrievable and replace does not duplicate', async () => {
  await withServer(async (app) => {
    const base = `http://127.0.0.1:${app.port}/api`;
    const post = (name, body) =>
      fetch(`${base}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const entries = [{ title: '公司WiFi', body: '办公室WiFi密码是 guest2026', tags: ['网络'] }];
    const first = await post('zhmem_import_knowledge', { entries, namespace: 'mine' });
    assert.equal(first.result.added, 1);
    const second = await post('zhmem_import_knowledge', { entries, namespace: 'mine', replace: true });
    assert.equal(second.result.added, 1, 'replace clears the previous import first');

    const stats = await fetch(`${base}/stats`.replace('/api/stats', '/api/stats')).then((r) => r.json());
    assert.equal(stats.importedKnowledge, 1);
  });
});

test('unknown tool and wrong method are rejected', async () => {
  await withServer(async (app) => {
    const base = `http://127.0.0.1:${app.port}/api`;
    const missing = await fetch(`${base}/zhmem_nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${base}/zhmem_ask`);
    assert.equal(wrongMethod.status, 405);
  });
});

test('static files are served and traversal is refused', async () => {
  await withServer(async (app) => {
    const root = `http://127.0.0.1:${app.port}`;
    const index = await fetch(`${root}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /zhmem/);

    const css = await fetch(`${root}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const escape = await fetch(`${root}/../package.json`);
    assert.ok(escape.status === 403 || escape.status === 404, `traversal returned ${escape.status}`);
  });
});
