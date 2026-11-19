# dsh-plugin-zhmem

中文记忆检索。装完就能用，不需要 Python，不需要额外配置——知识库随包一起走，记忆存在本地 SQLite 里。

**不想折腾插件？** [下 zip](https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest/download/zhmem-0.2.0.zip)，解压，双击 `启动.bat`。就这样。

三件事：

- **内置知识库** 84 条（生活 36 / 旅游 24 / 健身 24），问「地震怎么办」「每天盐摄入量」直接命中
- **个人记忆** 往里存东西，按语义召回，跨会话不丢
- **本地不够就联网** 本地证据弱于 0.45 时自动补网络资料，附来源链接

---

## 安装

两条路，选一条就行。同一份代码，两种用法。

### 路一：下载解压，双击就用（不装插件）

去 <https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest> 下 zip，解压到任意目录，双击 `启动.bat`。

直链：<https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest/download/zhmem-0.2.0.zip>

会起一个本地服务，再弹一个独立浏览器窗口，关掉窗口服务就跟着退出。第一次启动会自己建库、灌入 84 条知识库，不需要联网。

前提只有一个：装了 Node 22 或更高。没有的话 bat 会提示你去 nodejs.org 下。这条路不碰 `dsh`，不碰插件市场，也不用 pnpm。

想改端口、换库位置，设环境变量再启动：

```bat
set PORT=8580
set ZHMEM_DB=D:\my\zhmem.db
set ZHMEM_OFFLINE=1
启动.bat
```

也可以不开窗口，只起服务：`node server.js`，然后自己用浏览器开 `http://127.0.0.1:8570/`。

### 路二：装成 DSH 插件

#### 首选：直接输入包名

```
dsh plugin --profile web add dsh-plugin-zhmem
```

桌面版（Electron 管的 profile）不认这条命令，见下面的「桌面版怎么装」。

#### 没发 npm，或镜像没同步

```
dsh plugin --profile web add github:woc-jpg/dsh-plugin-zhmem
```

`github:owner/repo` 走 codeload 打包下载，几秒完成。

**不要粘 `https://github.com/woc-jpg/dsh-plugin-zhmem`**。pnpm 会把它当 git 依赖，先跑 `git ls-remote`，国内网络下经常卡到超时，最后报一个和真实原因无关的错。

#### 桌面版怎么装

桌面版的 profile 归 Electron 所有，`dsh plugin` 会拒绝写入。改 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-zhmem"]
    }
  }
}
```

然后在该 profile 目录里 `pnpm install`，重启。

#### 让智能体自己装

直接跟它说：

> 装一下 zhmem 插件，包名 dsh-plugin-zhmem，装不上就用 github:woc-jpg/dsh-plugin-zhmem

智能体手上是同一套 `dsh plugin` 命令。它失败时几乎总是同一个原因：把 GitHub 网页地址当成了安装参数。如果它反复装不上，就用路一，下载解压双击，绕开包管理器。

---

## 用起来

窗口里第一页就是对话。不是把检索结果换个样式摆出来——它会记住你说过的话，能接「那它呢」「继续说刚才那个」，回答前先翻你的知识库、记忆和已索引的文件。

**两件事先说清楚，免得期待错位：**

1. **没配模型也能对话**，但回答方式不同。没配的时候，程序把检索到的材料组织成一段连贯的话，界面上标「未配模型 · 检索结果直出」。配了模型（下面「接一个模型」那节），由模型组织语言，材料仍然来自本地检索。两种模式在回答底部都有标记，不会假装。
2. 每次回答下面都列出来源：哪条知识库、哪个文件、哪个网页。点得开、核对得了。

对话存在数据库里，按 `session` 分开。窗口的「新对话」开一段新的，「清空」只清当前这段。

### 加自己的文件进来

「文件」页填一个文件夹路径，「加入索引」。之后对话和检索都能用到里面的内容。

- **能读**：`.txt .md .json .yaml .csv` 这类文本，`.py .js .ts .go .java .rs` 这类代码，`.html .css .sql`，以及 `.docx`（Word 文档直接读，不用转 PDF）
- **只记文件名**：PDF、图片、音视频、压缩包 —— 能搜到「有这么个文件」，但搜不到里面写了什么
- **跳过**：`node_modules`、`.git`、`dist`、`build`、`__pycache__` 这些目录不看；超过 8 MB 的单个文本文件跳过

索引是增量的：第二次点「加入索引」只处理变过的文件。文件删了下次索引会从库里移出。想从头来一遍就点「全部重读」。

搜索给的是文件里**命中的那一段**，不是文件开头——长文档的开头几乎从不是答案所在。

### 接一个模型

在 `启动.bat` 旁边建 `zhmem.env`，写三行：

```
ZHMEM_MODEL_URL=https://api.deepseek.com/chat/completions
ZHMEM_MODEL=deepseek-chat
ZHMEM_MODEL_KEY=sk-xxxxxxxx
```

任何 OpenAI 兼容接口都行，本地的 vLLM、Ollama 的 `/v1`、通义、智谱都是这个形状。**地址要写到 `/chat/completions`**，程序不替你补路径。

接口挂了不会连带丢掉检索结果：连接失败会退回「检索结果直出」，前面加一句「（模型没连上：…）」说明原因。

---

## 工具

装成插件之后多出十四个工具，名字都以 `zhmem_` 开头：

| 工具 | 干什么 |
|---|---|
| `zhmem_ask` | 单次提问。本地知识库 + 按需联网 + 配图 |
| `zhmem_chat` | **带上下文的多轮对话**，会翻本地文件和记忆 |
| `zhmem_remember` | 存一条记忆 |
| `zhmem_recall` | 按语义找记忆 |
| `zhmem_forget` | 删一条记忆 |
| `zhmem_list_memories` | 列最近的记忆 |
| `zhmem_index_files` | 把一个文件夹加进索引 |
| `zhmem_search_files` | 在已索引的文件里搜内容 |
| `zhmem_file_stats` | 索引了多少文件、多少字、哪些目录 |
| `zhmem_web_search` | 只联网，不碰本地 |
| `zhmem_image_search` | 只找图 |
| `zhmem_stats` | 现在存了多少东西 |
| `zhmem_import_knowledge` | 导入自己的知识文件 |
| `zhmem_knowledge_template` | 生成一份照着填的模板 |

`zhmem_ask` 和 `zhmem_chat` 的区别：前者问一句答一句，不记前文；后者记得住，也会引用本地文件。要连续追问就用 `chat`。

直接说话就行，智能体自己挑工具：

> 地震的时候该怎么办
> 记住我妈对青霉素过敏
> 我以前说过对什么过敏吗
> 把 D:\资料\笔记 加进索引，然后告诉我里面关于报销的部分说了什么

---

## 自己的知识库

内置的 84 条不够用，就加自己的。三种加法，从轻到重。

### 一、一条一条存

> 记住：家里的路由器管理地址 192.168.1.1，密码写在书房抽屉的便签上

存进 `default` 命名空间，以后问「路由器密码」能召回。

### 二、拿模板填一批

让智能体调 `zhmem_knowledge_template`，会在 `~/.workbuddy/zhmem-knowledge/my-knowledge.json` 写一份带两条示例的文件：

```json
[
  {
    "id": "my-001",
    "title": "家里的路由器密码",
    "body": "路由器管理地址 192.168.1.1，管理员账号 admin，密码写在书房抽屉的便签上。",
    "tags": ["路由器", "密码", "wifi"],
    "salience": 0.6
  }
]
```

照着改，然后说「导入我的知识库」。

字段就四个要紧的：

- `title` 标题，检索时当主题词，**短一点更准**（四字以内命中率最高）
- `body` 正文，单条 4000 字以内
- `tags` 可选，同义词和别名放这儿，能明显提高召回
- `salience` 可选，0 到 1，重要的给 0.8 以上

`id` 别重复。重复导入同一个文件是**覆盖**不是追加，改完重导一次就行。

### 三、整份知识库搬进来

如果手上已经有现成的一批资料（Markdown、表格、旧的 FAQ 文档），交给智能体：

> 把 D:\资料\我的笔记 里的内容整理成 zhmem 的知识格式，一条一个主题，标题控制在四个字以内，然后导入

它会读、切分、转成上面的 JSON、调 `zhmem_import_knowledge`。切分的粒度很重要：一条装一件事，标题短，别名全——这三条决定后面能不能搜到。

导入的知识进 `mine` 命名空间，和内置的 84 条一起参与检索，不用切换。

---

## 数据在哪，怎么搬家

默认位置：

| 内容 | 位置 |
|---|---|
| 记忆数据库 | `~/.workbuddy/zhmem-memory.db` |
| 自己的知识文件 | `~/.workbuddy/zhmem-knowledge/` |

**想搬到别的盘**（比如 C 盘挤了，或者想跟程序放一起）：在 `启动.bat` 旁边建一个 `zhmem.env`，写一行：

```
ZHMEM_DB=D:\zhmem\zhmem-memory.db
```

目录不存在会自动建，知识文件跟着数据库走，一起挪到 `D:\zhmem\zhmem-knowledge\`。

搬已有的库：先关掉窗口，再把老文件复制过去（记得连 `-wal`、`-shm` 一起，或者干脆照下面做一次干净导出），然后改 `zhmem.env` 重启。

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('旧路径');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
```

WAL 没合并进主文件就复制，会丢掉最后几次写入——`-wal` 文件可能就是几 MB。缩略成一句：**先 checkpoint，再复制**。

`zhmem.env` 的完整写法见包里的 `zhmem.env.example`。真实环境变量优先于这个文件，所以临时跑一次可以直接 `set ZHMEM_DB=...` 而不改文件。

备份就是复制那两个路径。内置知识库不占这两个位置——它在包里，跟着版本走，不用备份。

---

## 三种用法，同一份检索核心

| 用法 | 入口 | 适合谁 |
|---|---|---|
| 独立窗口 | 双击 `启动.bat` | 不想碰命令行、不装 DSH 插件 |
| DSH 插件 | `dsh plugin add` | 已经在用 DSH，想让智能体自己调 |
| MCP 服务 | `node lib/mcp.js` | 只认 MCP 的客户端 |

三者的打分逻辑、知识库、数据库完全是同一份代码，所以同一个问题在哪问都是同样的答案。

独立版还带一个 HTTP 接口，除了给人点，也能给别的程序调：

```bash
curl -s http://127.0.0.1:8570/api/status
curl -s -X POST http://127.0.0.1:8570/api/zhmem_ask \
  -H 'content-type: application/json' \
  -d '{"query":"每天盐摄入量"}'

# 对话（会带上该 session 的前文）
curl -s -X POST http://127.0.0.1:8570/api/chat \
  -H 'content-type: application/json' \
  -d '{"text":"那住宿呢","session":"default"}'

# 索引一个文件夹，然后搜
curl -s -X POST http://127.0.0.1:8570/api/files/index \
  -H 'content-type: application/json' -d '{"path":"D:\\资料\\笔记"}'
curl -s -X POST http://127.0.0.1:8570/api/files/search \
  -H 'content-type: application/json' -d '{"query":"报销流程"}'
```

`POST /api/<工具名>` 把工具的入参原样转进去，返回 `{ok, result}`。`/api/chat` 和 `/api/files/*` 是单独的路由，返回结构化数据（来源、片段、评分），方便前端排版而不是解析一段 markdown。

---

## 配置项

**独立窗口版**读 `启动.bat` 旁边的 `zhmem.env`：

| 键 | 默认 | 说明 |
|---|---|---|
| `ZHMEM_DB` | `~/.workbuddy/zhmem-memory.db` | 记忆库路径，知识文件夹跟着走 |
| `PORT` | `8570` | 本地端口 |
| `ZHMEM_OFFLINE` | 不设 | 设成 `1` 就完全不联网 |
| `ZHMEM_BROWSER` | 自动找 Edge 再找 Chrome | 用哪个浏览器开窗口 |
| `ZHMEM_WINDOW` | `1296x828` | 窗口大小，居中打开。拖过窗口之后记的是你拖的尺寸 |
| `ZHMEM_MODEL_URL` | 不设 | 模型接口地址，要写到 `/chat/completions` |
| `ZHMEM_MODEL` | 不设 | 模型名，例如 `deepseek-chat` |
| `ZHMEM_MODEL_KEY` | 不设 | 接口密钥 |
| `ZHMEM_MODEL_TEMPERATURE` | `0.3` | 0 到 1，越低越稳 |

不填模型那三项也能正常用，只是回答由检索结果直接组织。`ZHMEM_MODEL_URL` 和 `ZHMEM_MODEL` 两个都填了才算配置好——只填一个会当作没配。

**插件版**接受三个配置，写进 profile 的 bundle 配置里：

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `~/.workbuddy/zhmem-memory.db` | 记忆库路径 |
| `offline` | `false` | 设 `true` 就完全不联网 |
| `webThreshold` | `0.45` | 本地证据低于这个值才联网 |

插件版要接模型，设 `ZHMEM_MODEL_URL` / `ZHMEM_MODEL` / `ZHMEM_MODEL_KEY` 环境变量（或者把 `zhmem.env` 放在 MCP 进程的工作目录），读的是同一套键。

`webThreshold` 调高会更爱联网，调低更相信本地。默认 0.45 是标定出来的：真话题的证据分基本在 0.45 以上，无关问句在 0.41 以下。

---

## 开发

```bash
node --test test/parity.test.mjs test/server.test.mjs test/config.test.mjs test/files.test.mjs test/chat.test.mjs
```

61 个用例。13 个把召回结果和 Python 版 zhmem 逐位对齐——命中的条目、证据分、总分三项都要一致；13 个跑 HTTP 那一层（播种、导入、静态文件、路径穿越、对话历史、文件索引增删）；4 个测配置文件解析；11 个测文件索引（各种编码、docx、超大文件、二进制、片段定位、增量）；20 个测对话（无模型降级、假接口的真模型路径、SSE 流式、接口挂掉时保住检索结果、历史截断）。改检索逻辑之后跑这个，数字变了就是改坏了。

```
lib/text.js        分词、覆盖度、查询清洗
lib/synonyms.js    同义词折叠（膝盖→膝、肚子→腹部）
lib/store.js       SQLite 存储 + 打分
lib/kb.js          知识库加载与导入
lib/retriever.js   本地/联网调度
lib/web.js         联网与图片（DuckDuckGo + Wikimedia，都不要 key）
lib/files.js       本地文件索引（文本/代码/docx，FTS5 增量）
lib/chat.js        对话层：历史、上下文拼装、模型流式、无模型降级
lib/tools.js       十四个工具的定义
lib/index.js       DSH 插件入口
lib/mcp.js         独立 MCP 服务
server.js          HTTP 服务（独立版）
public/            独立版前端，纯 HTML/CSS/JS，没有构建步骤
launcher.js        双击启动：起服务 + 开浏览器窗口
data/*.json        84 条内置知识
```

零依赖这一点是刻意的：`node:sqlite` 和 FTS5 都是 Node 自带的，装的时候不用编译原生模块，也不会有 Python 版本对不上的问题。

---

## 许可

MIT
