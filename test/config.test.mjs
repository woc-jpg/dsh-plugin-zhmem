import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFile, ENV_FILE } from '../lib/config.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zhmem-env-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('missing file is not an error', () => {
  withDir((dir) => {
    const result = loadEnvFile(dir, { silent: true });
    assert.deepEqual(result.applied, []);
    assert.equal(result.file, join(dir, ENV_FILE));
  });
});

test('reads KEY=VALUE, skips comments and blanks, strips quotes', () => {
  withDir((dir) => {
    writeFileSync(join(dir, ENV_FILE), [
      '# comment',
      '',
      'ZHMEM_TEST_PORT=8580',
      'ZHMEM_TEST_QUOTED="D:\\data\\quoted.db"',
      "ZHMEM_TEST_SINGLE='single'",
      'not a pair',
    ].join('\r\n'));

    delete process.env.ZHMEM_TEST_PORT;
    delete process.env.ZHMEM_TEST_QUOTED;
    delete process.env.ZHMEM_TEST_SINGLE;

    const { applied } = loadEnvFile(dir, { silent: true });
    assert.equal(applied.length, 3);
    assert.equal(process.env.ZHMEM_TEST_PORT, '8580');
    assert.equal(process.env.ZHMEM_TEST_QUOTED, 'D:\\data\\quoted.db');
    assert.equal(process.env.ZHMEM_TEST_SINGLE, 'single');

    delete process.env.ZHMEM_TEST_PORT;
    delete process.env.ZHMEM_TEST_QUOTED;
    delete process.env.ZHMEM_TEST_SINGLE;
  });
});

test('a real environment variable beats the file', () => {
  withDir((dir) => {
    writeFileSync(join(dir, ENV_FILE), 'ZHMEM_TEST_WIN=from-file\n');
    process.env.ZHMEM_TEST_WIN = 'from-shell';
    const { applied } = loadEnvFile(dir, { silent: true });
    assert.equal(process.env.ZHMEM_TEST_WIN, 'from-shell');
    assert.equal(applied.length, 0);
    delete process.env.ZHMEM_TEST_WIN;
  });
});

test('value may contain equals signs', () => {
  withDir((dir) => {
    writeFileSync(join(dir, ENV_FILE), 'ZHMEM_TEST_EQ=a=b=c\n');
    delete process.env.ZHMEM_TEST_EQ;
    loadEnvFile(dir, { silent: true });
    assert.equal(process.env.ZHMEM_TEST_EQ, 'a=b=c');
    delete process.env.ZHMEM_TEST_EQ;
  });
});
