// The tool surface: nine tools, same names and arguments as the Python MCP
// server, plus one that only makes sense once the plugin owns the knowledge
// import.
//
// Tool descriptions are part of the interface - an agent decides what to call
// from the description alone, so each one states when to use it rather than what
// it does mechanically.

import { readFileSync } from 'node:fs';

import { MemoryStore, defaultDbPath, VERSION } from './store.js';
import { KnowledgeBase, importKnowledge, validateKnowledge, describe, ensureUserKnowledgeDir, writeTemplate, BUILTIN_NAMESPACES } from './kb.js';
import { Retriever } from './retriever.js';
import { FileIndex } from './files.js';
import { ChatEngine, MessageLog } from './chat.js';

const WEB_MODES = { auto: null, always: true, never: false };

/**
 * Owns the lazily-opened SQLite handles.
 *
 * Both halves live in one file: the knowledge base is seeded into the same
 * database as personal memories, so a query can hit both without a second
 * connection and without two WAL writers.
 */
export class ZhmemRuntime {
  constructor({ dbPath = null, offline = false, webThreshold = undefined, model = null } = {}) {
    this.dbPath = dbPath ?? defaultDbPath();
    this.offline = offline;
    this.webThreshold = webThreshold;
    this.model = model ?? readModelConfig();
    this._store = null;
    this._retriever = null;
    this._files = null;
    this._log = null;
    this._chat = null;
  }

  get store() {
    if (!this._store) {
      // `subjectBonus: 1.0` matches the Python side: entry titles are curated, so
      // the title counts as evidence. An empty subject cannot manufacture any -
      // `_subjectHit` bails out before scoring when `memory.subject` is blank.
      this._store = new MemoryStore(this.dbPath, { subjectBonus: 1.0 });
      // Seed the built-in knowledge base into its own namespaces. `install`
      // skips nothing, so seeding is guarded by a count check - otherwise every
      // process start would duplicate all 84 entries.
      const counts = this._store.counts();
      const missing = BUILTIN_NAMESPACES.filter((ns) => !counts[ns]);
      if (missing.length) {
        const kb = new KnowledgeBase(':memory:', { namespaces: missing });
        for (const memory of kb.store.list(null, { limit: 100000 })) {
          this._store.add(memory.namespace, memory.body, {
            kind: 'kb',
            subject: memory.subject,
            salience: memory.salience,
            meta: memory.meta,
            searchText: memory.meta?.tags?.length
              ? [memory.subject, memory.body, ...memory.meta.tags].join(' ')
              : undefined,
          });
        }
        kb.close();
      }
    }
    return this._store;
  }

  get retriever() {
    if (!this._retriever) {
      this._retriever = new Retriever({
        store: this.store,
        offline: this.offline,
        ...(this.webThreshold !== undefined ? { webThreshold: this.webThreshold } : {}),
      });
    }
    return this._retriever;
  }

  /** The file index shares the store's connection - one file, one WAL writer. */
  get files() {
    if (!this._files) this._files = new FileIndex(this.store.db);
    return this._files;
  }

  get messages() {
    if (!this._log) this._log = new MessageLog(this.store.db);
    return this._log;
  }

  get chat() {
    if (!this._chat) {
      this._chat = new ChatEngine({
        retriever: this.retriever,
        files: this.files,
        log: this.messages,
        config: this.model,
      });
    }
    return this._chat;
  }

  close() {
    this._store?.close();
    this._store = null;
    this._retriever = null;
    this._files = null;
    this._log = null;
    this._chat = null;
  }
}

/**
 * Model settings, from the environment or zhmem.env.
 *
 * Read lazily at construction rather than at module load so tests that set the
 * variables after import still take effect. An empty endpoint means "no model",
 * which selects composed replies - the plugin never guesses a default service,
 * because a silent call to someone's API would be both surprising and billable.
 */
export function readModelConfig() {
  const url = (process.env.ZHMEM_MODEL_URL ?? '').trim();
  return {
    url: url || null,
    apiKey: (process.env.ZHMEM_MODEL_KEY ?? '').trim() || null,
    model: (process.env.ZHMEM_MODEL ?? '').trim() || null,
    temperature: Number.isFinite(Number(process.env.ZHMEM_MODEL_TEMPERATURE))
      ? Number(process.env.ZHMEM_MODEL_TEMPERATURE)
      : 0.3,
  };
}

/** Resolve a web_mode string to the tri-state the retriever expects. */
export function resolveWebMode(mode) {
  if (mode === undefined || mode === null || mode === '') return undefined;
  if (!(mode in WEB_MODES)) {
    throw new Error(`web_mode 只能是 auto / always / never，收到「${mode}」`);
  }
  return WEB_MODES[mode];
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * Build the tool definitions.
 *
 * `runtime` is injected rather than imported as a singleton so tests can point
 * the whole surface at a temporary database - and so a second profile in the
 * same process does not share a handle.
 */
export function createTools(runtime = new ZhmemRuntime()) {
  return [
    {
      name: 'zhmem_ask',
      description: '问一个问题，先用内置知识库和个人记忆回答，本地命中弱时自动联网并附来源链接与图片。这是主入口：用户问「怎么/为什么/多少」这类问题时调用它，而不是自己回忆。要连续对话、要结合本地文件回答时用 zhmem_chat。',
      parameters: {
        query: { type: 'string', required: true, description: '用户的问题原话，不要改写' },
        recent: {
          type: 'array',
          items: { type: 'string' },
          description: '最近一两轮对话，用于解析「那」「上次」这类指代',
        },
        web_mode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'auto 默认：本地够强就不联网；always 强制联网；never 只查本地',
        },
        images: { type: 'boolean', description: '是否附图片，默认 true' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      async execute(args) {
        const mode = resolveWebMode(args.web_mode);
        const answer = await runtime.retriever.ask(args.query, {
          recent: args.recent ?? [],
          images: args.images !== false,
          ...(mode !== undefined ? { web: mode } : {}),
        });
        return {
          markdown: answer.render({ images: args.images !== false }),
          used_web: answer.usedWeb,
          local: answer.localCitations(),
          web: answer.web.map((r) => ({ title: r.title, url: r.url })),
          images: answer.images.map((r) => ({ title: r.title, url: r.url, page: r.page })),
          reason: answer.reason,
        };
      },
    },

    {
      name: 'zhmem_remember',
      description: '把用户说的一件值得记住的事存进个人记忆库，之后可以按语义召回。用户提到自己的偏好、计划、家人情况、住址、账号位置时调用。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的内容，一句完整的话' },
        namespace: { type: 'string', description: '分组名，默认 default；不同主题用不同分组便于隔离' },
        subject: { type: 'string', description: '主题词，短标题，能显著提高召回率' },
        kind: { type: 'string', description: '类型标记，默认 note' },
        salience: { type: 'number', description: '重要性 0 到 1，默认 0.5；长期有效的写高一些' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute(args) {
        const id = runtime.store.add(args.namespace || 'default', args.text, {
          kind: args.kind || 'note',
          subject: args.subject || '',
          salience: Number.isFinite(args.salience) ? args.salience : 0.5,
        });
        return { id, message: `已记住（#${id}）` };
      },
    },

    {
      name: 'zhmem_recall',
      description: '在个人记忆库里按语义查找以前存过的事。回答前先想：这条信息是不是用户以前告诉过我？是就调用它。',
      parameters: {
        query: { type: 'string', required: true, description: '要找什么' },
        namespace: { type: 'string', description: '只在这个分组里找，默认 default' },
        limit: { type: 'number', description: '返回条数，默认 5' },
        recent: { type: 'array', items: { type: 'string' }, description: '最近对话，用于解析指代' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      execute(args) {
        const hits = runtime.store.recall(args.namespace || 'default', args.query, {
          limit: Number.isFinite(args.limit) ? args.limit : 5,
          recent: args.recent ?? [],
        });
        return {
          markdown: hits.length ? MemoryStore.render(hits, { maxItems: args.limit ?? 5 }) : '记忆库里没有相关记录。',
          count: hits.length,
          ids: hits.map((h) => h.memory.id),
        };
      },
    },

    {
      name: 'zhmem_forget',
      description: '删除一条个人记忆。用户说「忘掉这个」「别记着」时调用，需要先有 id（从 zhmem_recall 或 zhmem_list_memories 得到）。',
      parameters: {
        item_id: { type: 'number', required: true, description: '要删除的记忆 id' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute(args) {
        const ok = runtime.store.forget(Number(args.item_id));
        return { ok, message: ok ? `已删除 #${args.item_id}` : `没有 id 为 ${args.item_id} 的记忆` };
      },
    },

    {
      name: 'zhmem_list_memories',
      description: '按时间倒序列出存过的记忆，用于查看都记了什么、找到要删的 id。',
      parameters: {
        namespace: { type: 'string', description: '只看某个分组，默认全部' },
        limit: { type: 'number', description: '条数，默认 20' },
        include_knowledge: { type: 'boolean', description: '是否把内置知识库和导入的知识也列出来，默认 false，只列你自己存的' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      execute(args) {
        // Default to the user's own notes only. Listing everything mixes the 84
        // built-in entries into "what did I save", which makes the answer
        // useless and the list enormous.
        const only = args.include_knowledge ? null : ['note'];
        const items = runtime.store.list(args.namespace || null, {
          limit: Number.isFinite(args.limit) ? args.limit : 20,
          kinds: only,
        });
        const lines = items.map((m) => `- #${m.id} [${m.namespace}] ${m.subject ? `**${m.subject}** ` : ''}${m.body}`);
        return { markdown: lines.length ? lines.join('\n') : '还没有存过任何记忆。', count: items.length };
      },
    },

    {
      name: 'zhmem_web_search',
      description: '直接联网搜索，不走本地知识库。需要最新信息、时事、价格这类内置知识库一定没有的内容时调用。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索词' },
        limit: { type: 'number', description: '结果条数，默认 5' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      async execute(args) {
        const results = await runtime.retriever.web.search(args.query, {
          limit: Number.isFinite(args.limit) ? args.limit : 5,
        });
        const lines = results.map((r) => `- [${r.title}](${r.url})${r.snippet ? `\n  ${r.snippet}` : ''}`);
        return { markdown: lines.length ? lines.join('\n') : '没有取到结果。', count: results.length };
      },
    },

    {
      name: 'zhmem_image_search',
      description: '按关键词找可用的图片，返回图片地址和来源页。需要给用户配图时调用。',
      parameters: {
        query: { type: 'string', required: true, description: '图片内容关键词，英文效果更好' },
        limit: { type: 'number', description: '张数，默认 4' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      async execute(args) {
        const results = await runtime.retriever.images.search(args.query, {
          limit: Number.isFinite(args.limit) ? args.limit : 4,
        });
        const lines = results.map((r) => `- ![${r.title}](${r.url})${r.page ? `（[来源](${r.page})）` : ''}`);
        return { markdown: lines.length ? lines.join('\n') : '没有找到图片。', count: results.length };
      },
    },

    {
      name: 'zhmem_stats',
      description: '查看知识库和记忆库的规模，用于确认插件是否正常工作、导入是否成功。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute() {
        const info = describe(runtime.store);
        return {
          ...info,
          version: VERSION,
          db: runtime.dbPath,
          message: [
            `内置知识库 ${info.builtinKnowledge} 条`,
            `导入的知识 ${info.importedKnowledge} 条`,
            `个人记忆 ${info.personalMemories} 条`,
            `数据库 ${runtime.dbPath}`,
          ].join('\n'),
        };
      },
    },

    {
      name: 'zhmem_import_knowledge',
      description: '把用户自己的知识文件导入知识库。用户说「我有一份自己的知识库/资料想让你用」时调用：先读他的文件，按 title+body 整理成数组，再传给这个工具。',
      parameters: {
        entries: {
          type: 'array',
          description: '知识条目数组，每条至少含 title 和 body；可选 id / tags / image_query / salience',
          items: { type: 'object' },
        },
        namespace: { type: 'string', description: '存到哪个分组，默认 mine' },
        replace: { type: 'boolean', description: '是否先清掉上次导入的同类知识，默认 true' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute(args) {
        const entries = args.entries ?? [];
        const check = validateKnowledge(entries);
        if (!check.ok) {
          return { ok: false, problems: check.problems, message: `文件有问题，未导入：\n${check.problems.slice(0, 10).join('\n')}` };
        }
        const result = importKnowledge(runtime.store, entries, {
          namespace: args.namespace || 'mine',
          replace: args.replace !== false,
        });
        return {
          ok: true,
          ...result,
          message: `已导入 ${result.total} 条到「${result.namespace}」（新增 ${result.added}，覆盖 ${result.updated}）`,
        };
      },
    },

    {
      name: 'zhmem_knowledge_template',
      description: '生成一份可编辑的知识文件模板并返回路径与内容，让用户照着填自己的知识。用户不知道知识文件该怎么写时调用。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute() {
        const dir = ensureUserKnowledgeDir();
        const file = writeTemplate(dir);
        const content = readFileSync(file, 'utf8');
        return {
          path: file,
          directory: dir,
          content,
          message: `模板已写入 ${file}\n\n${content}\n\n填好后把内容交给 zhmem_import_knowledge，或直接说「导入我的知识库」。`,
        };
      },
    },

    {
      name: 'zhmem_chat',
      description: '和用户连续对话。会先检索知识库、个人记忆和已索引的本地文件，再据此回答——配了模型就由模型组织语言，没配就把检索结果写成一段回答。用户说「聊聊」「帮我看看」「继续刚才那个」时用它；单纯查一个事实用 zhmem_ask 更快。',
      parameters: {
        text: { type: 'string', required: true, description: '用户这一句原话' },
        session: { type: 'string', description: '会话名，默认 default；不同话题用不同名字可以隔离上下文' },
        use_files: { type: 'boolean', description: '是否检索本地文件，默认 true' },
        web_mode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'auto 默认：本地够强就不联网；always 强制联网；never 只查本地',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.reply ?? v) },
      async execute(args) {
        const mode = resolveWebMode(args.web_mode);
        const result = await runtime.chat.send({
          session: args.session || 'default',
          text: args.text,
          useFiles: args.use_files !== false,
          ...(mode !== null && mode !== undefined ? { useWeb: mode } : {}),
        });
        const tail = result.sources.length
          ? `\n\n---\n来源：${result.sources.slice(0, 5).map((s) => (s.kind === 'file' ? `文件 ${s.title}` : s.title)).join('、')}`
          : '';
        return { ...result, markdown: result.reply + tail };
      },
    },

    {
      name: 'zhmem_index_files',
      description: '把一个本地目录加进索引，之后就能按内容搜里面的文件。用户说「搜我电脑里的资料」「读一下我这个文件夹」时，先问清目录路径再调用。支持的格式：文本、代码、markdown、json、docx；其他格式只记文件名不读内容。',
      parameters: {
        path: { type: 'string', required: true, description: '要索引的目录绝对路径，例如 D:\\资料\\笔记' },
        force: { type: 'boolean', description: '是否强制重读所有文件，默认 false，只处理新增和改过的' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute(args) {
        const result = runtime.files.index(args.path, { force: args.force === true });
        const lines = [
          `目录 ${result.root}`,
          `扫到 ${result.scanned} 个可读文件：新增 ${result.added}，更新 ${result.updated}，没变 ${result.unchanged}，移出 ${result.removed}`,
        ];
        if (result.skippedCount) {
          const sample = result.skipped.slice(0, 5).map((s) => `${s.file}（${s.reason}）`).join('\n  ');
          lines.push(`另有 ${result.skippedCount} 个文件读不了，只记了名字：\n  ${sample}`);
        }
        return { ...result, message: lines.join('\n') };
      },
    },

    {
      name: 'zhmem_search_files',
      description: '在已索引的本地文件里按内容查找，返回文件名、路径和命中的片段。要引用用户自己文档里的内容时用它，不要凭记忆回答。',
      parameters: {
        query: { type: 'string', required: true, description: '要找什么' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        root: { type: 'string', description: '只在这个目录下找，默认全部已索引目录' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.markdown ?? v) },
      execute(args) {
        const hits = runtime.files.search(args.query, {
          limit: Number.isFinite(args.limit) ? args.limit : 8,
          root: args.root ?? null,
        });
        if (!hits.length) {
          const stats = runtime.files.stats();
          return {
            markdown: stats.files
              ? '已索引的文件里没有匹配。换个说法，或者把这个目录也加进来。'
              : '还没有索引任何目录。先说要索引哪个文件夹。',
            count: 0,
          };
        }
        const lines = hits.map((h) => [
          `- **${h.name}**（相关度 ${h.score}）`,
          `  ${h.path}`,
          h.snippet ? `  ${h.snippet}` : '',
          h.error ? `  （这个文件只记了名字：${h.error}）` : '',
        ].filter(Boolean).join('\n'));
        return { markdown: lines.join('\n'), count: hits.length, paths: hits.map((h) => h.path) };
      },
    },

    {
      name: 'zhmem_file_stats',
      description: '查看本地文件索引里有什么：索引了哪些目录、共多少文件。用户问「你都能看到我哪些文件」时调用。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.message ?? v) },
      execute() {
        const stats = runtime.files.stats();
        if (!stats.files) return { ...stats, message: '还没有索引任何目录。' };
        const lines = [
          `索引了 ${stats.files} 个文件，正文共 ${stats.chars} 字`,
          ...stats.roots.map((r) => `- ${r.root}（${r.files} 个文件，${r.chars} 字）`),
        ];
        return { ...stats, message: lines.join('\n') };
      },
    },
  ];
}

export default createTools;
