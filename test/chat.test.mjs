import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ZhmemRuntime } from '../lib/tools.js';
import { ChatEngine, MessageLog, composeAnswer, buildContext, streamChat, DEFAULT_SYSTEM, isFollowUp, resolveQuery, previousTopic } from '../lib/chat.js';

async function withRuntime(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zhmem-chat-'));
  const runtime = new ZhmemRuntime({ dbPath: join(dir, 'test.db'), offline: true, ...options });
  try {
    return await fn({ runtime, dir });
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('composed reply quotes the knowledge base instead of inventing', async () => {
  await withRuntime(async ({ runtime }) => {
    const result = await runtime.chat.send({ text: '深蹲怎么做才对', useFiles: false });
    assert.equal(result.composed, true);
    assert.match(result.reply, /深蹲/);
    assert.ok(result.sources.some((s) => s.kind === 'kb'));
  });
});

test('composed reply says so when nothing matches', async () => {
  await withRuntime(async ({ runtime }) => {
    const result = await runtime.chat.send({ text: 'quasarbloom', useFiles: false });
    assert.match(result.reply, /没找到|没有找到/);
    assert.equal(result.sources.length, 0);
  });
});

test('composeAnswer is honest about an empty collection', () => {
  const reply = composeAnswer({ query: '某个东西' });
  assert.match(reply, /没找到|没有找到/);
});

test('the conversation remembers the previous turn', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 's1', text: '敦煌怎么玩', useFiles: false });
    const history = runtime.messages.history('s1');
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');
  });
});

test('sessions are independent', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 'a', text: '第一句', useFiles: false });
    await runtime.chat.send({ session: 'b', text: '第二句', useFiles: false });
    assert.equal(runtime.messages.history('a').length, 2);
    assert.equal(runtime.messages.history('b').length, 2);
    assert.equal(runtime.messages.history('a')[0].content, '第一句');
  });
});

test('clear empties one session only', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 'a', text: '甲', useFiles: false });
    await runtime.chat.send({ session: 'b', text: '乙', useFiles: false });
    runtime.messages.clear('a');
    assert.equal(runtime.messages.history('a').length, 0);
    assert.equal(runtime.messages.history('b').length, 2);
  });
});

test('an empty message is rejected', async () => {
  await withRuntime(async ({ runtime }) => {
    await assert.rejects(() => runtime.chat.send({ text: '   ' }), /别发空的/);
  });
});

test('file hits reach the answer and the sources', async () => {
  await withRuntime(async ({ runtime, dir }) => {
    writeFileSync(join(dir, 'plan.md'), '下周去敦煌，重点是莫高窟和鸣沙山。');
    runtime.files.index(dir);

    const result = await runtime.chat.send({ text: '莫高窟' });
    assert.ok(result.fileHits.length >= 1);
    assert.equal(result.fileHits[0].name, 'plan.md');
    assert.ok(result.sources.some((s) => s.kind === 'file'));
    assert.match(result.reply, /plan\.md/);
  });
});

test('file search can be turned off per turn', async () => {
  await withRuntime(async ({ runtime, dir }) => {
    writeFileSync(join(dir, 'plan.md'), '下周去敦煌，重点是莫高窟和鸣沙山。');
    runtime.files.index(dir);
    const result = await runtime.chat.send({ text: '莫高窟', useFiles: false });
    assert.equal(result.fileHits.length, 0);
  });
});

test('buildContext labels every source so a citation can point somewhere', () => {
  const context = buildContext({
    local: [{ memory: { namespace: 'travel', subject: '敦煌', body: '莫高窟要预约。', id: 1, meta: {} }, score: 0.9 }],
    files: [{ name: 'a.md', path: 'D:\\a.md', body: '文件正文' }],
    web: [{ title: '某站', url: 'https://example.com', snippet: '摘要' }],
  });
  assert.match(context, /【知识库\/travel】敦煌/);
  assert.match(context, /【文件】a\.md/);
  assert.match(context, /【网络】某站/);
});

test('buildContext stops at the character budget', () => {
  const local = Array.from({ length: 50 }, (_, i) => ({
    memory: { namespace: 'x', subject: `t${i}`, body: '字'.repeat(500), id: i, meta: {} },
    score: 1,
  }));
  const context = buildContext({ local });
  assert.ok(context.length < 7000, `context was ${context.length} chars`);
});

test('composeAnswer mentions the top file and its snippet', () => {
  const reply = composeAnswer({
    query: '预算',
    files: [{ name: 'budget.md', path: '/b.md', snippet: '总预算三万', score: 0.8 }],
  });
  assert.match(reply, /budget\.md/);
  assert.match(reply, /总预算三万/);
});

/** A stand-in for an OpenAI-compatible endpoint, so the model path is tested for real. */
async function fakeModel(handler) {
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, close: () => new Promise((r) => server.close(r)) };
}

test('model mode sends the retrieved context and uses the reply', async () => {
  let seen = null;
  const fake = await fakeModel(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '莫高窟需要提前预约。' } }] }));
  });

  try {
    await withRuntime(async ({ runtime }) => {
      runtime.model = { url: fake.url, apiKey: 'k', model: 'test-model', temperature: 0.2 };
      runtime._chat = new ChatEngine({ retriever: runtime.retriever, files: runtime.files, log: runtime.messages, config: runtime.model });
      const result = await runtime.chat.send({ text: '莫高窟要预约吗', useFiles: false });
      assert.equal(result.composed, false);
      assert.match(result.reply, /提前预约/);
      assert.equal(seen.model, 'test-model');
      assert.equal(seen.messages[0].role, 'system');
      assert.match(seen.messages[0].content, /zhmem/);
      assert.ok(seen.messages.some((m) => m.role === 'system' && /检索到的材料/.test(m.content)));
      assert.equal(seen.messages.at(-1).content, '莫高窟要预约吗');
    });
  } finally {
    await fake.close();
  }
});

test('model mode streams SSE deltas', async () => {
  const fake = await fakeModel((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['莫高', '窟要', '预约']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const out = await streamChat({ url: fake.url, model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.text, '莫高窟要预约');
    assert.equal(out.streamed, true);
  } finally {
    await fake.close();
  }
});

test('a dead model endpoint degrades to the composed reply', async () => {
  await withRuntime(async ({ runtime }) => {
    runtime.model = { url: 'http://127.0.0.1:9/v1/chat/completions', apiKey: null, model: 'x', temperature: 0.3 };
    runtime._chat = new ChatEngine({ retriever: runtime.retriever, files: runtime.files, log: runtime.messages, config: runtime.model });
    const result = await runtime.chat.send({ text: '深蹲怎么做', useFiles: false });
    assert.equal(result.composed, true);
    assert.match(result.reply, /模型没连上/);
    assert.match(result.reply, /深蹲/);
  });
});

test('a failing endpoint surfaces the status text', async () => {
  const fake = await fakeModel((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad key' }));
  });
  try {
    await assert.rejects(
      () => streamChat({ url: fake.url, model: 'm', messages: [] }),
      /401/,
    );
  } finally {
    await fake.close();
  }
});

test('history is capped to the last turns sent to the model', async () => {
  let count = 0;
  const fake = await fakeModel(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    count = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });

  try {
    await withRuntime(async ({ runtime }) => {
      runtime.model = { url: fake.url, model: 'm' };
      runtime._chat = new ChatEngine({ retriever: runtime.retriever, files: runtime.files, log: runtime.messages, config: runtime.model });
      for (let i = 0; i < 20; i += 1) {
        await runtime.chat.send({ session: 'long', text: `第${i}句`, useFiles: false });
      }
      // system + context + at most 12 history turns + this user turn
      assert.ok(count <= 15, `sent ${count} messages`);
    });
  } finally {
    await fake.close();
  }
});

test('MessageLog reports sessions for the sidebar', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 'x', text: '一', useFiles: false });
    await runtime.chat.send({ session: 'y', text: '二', useFiles: false });
    const sessions = runtime.messages.sessions();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => s.turns === 2));
  });
});

test('describe reports composed mode without a model', async () => {
  await withRuntime(async ({ runtime }) => {
    assert.deepEqual(runtime.chat.describe(), { model: null, endpoint: null, mode: 'composed' });
  });
});

test('DEFAULT_SYSTEM forbids inventing sources', () => {
  assert.match(DEFAULT_SYSTEM, /不要编/);
  assert.match(DEFAULT_SYSTEM, /来源/);
});

// ---- 指代消解 ------------------------------------------------------------
// Measured live before the fix: 「那边住宿贵吗」after 「敦煌三天怎么安排」
// ranked 日本旅游攻略 first (0.332) and 敦煌 third (0.302). These pin both
// sides of the gate: a follow-up borrows the topic, a fresh topic does not.

test('isFollowUp separates pointers from fresh topics', () => {
  for (const q of ['那边住宿贵吗', '那边呢', '住宿呢', '刚才那个', '继续说', '它怎么样']) {
    assert.equal(isFollowUp(q), true, `expected follow-up: ${q}`);
  }
  for (const q of ['膝盖疼怎么办', '失眠怎么改善', '泰国旅游注意事项', '深蹲正确动作']) {
    assert.equal(isFollowUp(q), false, `expected fresh topic: ${q}`);
  }
});

test('previousTopic takes the leading CJK segment, at most four characters', () => {
  assert.equal(previousTopic('敦煌三天怎么安排'), '敦煌三天');
  assert.equal(previousTopic('膝盖疼怎么办'), '膝盖');
  assert.equal(previousTopic('deepseek python install'), '');
});

test('resolveQuery injects the topic only for a follow-up', () => {
  assert.equal(resolveQuery('那边住宿贵吗', '敦煌三天怎么安排').searchQuery, '敦煌三天 那边住宿贵吗');
  assert.equal(resolveQuery('膝盖疼怎么办', '敦煌三天怎么安排').searchQuery, '膝盖疼怎么办');
  // If the user already named the topic, injecting again would double it.
  assert.equal(resolveQuery('敦煌住宿贵吗', '敦煌三天怎么安排').resolved, false);
});

test('a follow-up actually retrieves the previous topic first', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 'f', text: '敦煌三天怎么安排', useFiles: false });
    const result = await runtime.chat.send({ session: 'f', text: '那边住宿贵吗', useFiles: false });
    assert.equal(result.resolved, true);
    assert.equal(result.topic, '敦煌三天');
    assert.match(result.sources[0].title, /敦煌/);
    // The transcript stays faithful: what the user typed, not the rewritten query.
    const history = runtime.messages.history('f');
    assert.equal(history[2].content, '那边住宿贵吗');
  });
});

test('a topic switch stays on the new topic', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.chat.send({ session: 's', text: '敦煌三天怎么安排', useFiles: false });
    const result = await runtime.chat.send({ session: 's', text: '失眠怎么改善', useFiles: false });
    assert.equal(result.resolved, false);
    assert.match(result.sources[0].title, /睡眠|失眠/);
  });
});
