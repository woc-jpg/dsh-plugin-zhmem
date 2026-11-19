# dsh-plugin-zhmem

中文记忆检索。装完就能用，不需要 Python，不需要额外配置——知识库随包一起走，记忆存在本地 SQLite 里。

**不想折腾插件？** [下 zip](https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest/download/zhmem-0.1.0.zip)，解压，双击 `启动.bat`。就这样。

三件事：

- **内置知识库** 84 条（生活 36 / 旅游 24 / 健身 24），问「地震怎么办」「每天盐摄入量」直接命中
- **个人记忆** 往里存东西，按语义召回，跨会话不丢
- **本地不够就联网** 本地证据弱于 0.45 时自动补网络资料，附来源链接

---

## 安装

两条路，选一条就行。同一份代码，两种用法。

### 路一：下载解压，双击就用（不装插件）

去 <https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest> 下 zip，解压到任意目录，双击 `启动.bat`。

直链：<https://github.com/woc-jpg/dsh-plugin-zhmem/releases/latest/download/zhmem-0.1.0.zip>

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

装完之后多出十个工具，名字都以 `zhmem_` 开头：

| 工具 | 干什么 |
|---|---|
| `zhmem_ask` | 主入口。本地知识库 + 按需联网 + 配图，一次问完 |
| `zhmem_remember` | 存一条记忆 |
| `zhmem_recall` | 按语义找记忆 |
| `zhmem_forget` | 删一条记忆 |
| `zhmem_list_memories` | 列最近的记忆 |
| `zhmem_web_search` | 只联网，不碰本地 |
| `zhmem_image_search` | 只找图 |
| `zhmem_stats` | 现在存了多少东西 |
| `zhmem_import_knowledge` | 导入自己的知识文件 |
| `zhmem_knowledge_template` | 生成一份照着填的模板 |

直接说话就行，智能体自己挑工具：

> 地震的时候该怎么办
> 记住我妈对青霉素过敏
> 我以前说过对什么过敏吗
> 每天盐摄入量多少合适

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
```

`POST /api/<工具名>` 直接把十个工具的入参原样转进去，返回 `{ok, result}`。

---

## 配置项

**独立窗口版**读 `启动.bat` 旁边的 `zhmem.env`：

| 键 | 默认 | 说明 |
|---|---|---|
| `ZHMEM_DB` | `~/.workbuddy/zhmem-memory.db` | 记忆库路径，知识文件夹跟着走 |
| `PORT` | `8570` | 本地端口 |
| `ZHMEM_OFFLINE` | 不设 | 设成 `1` 就完全不联网 |
| `ZHMEM_BROWSER` | 自动找 Edge 再找 Chrome | 用哪个浏览器开窗口 |

**插件版**接受三个配置，写进 profile 的 bundle 配置里：

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `~/.workbuddy/zhmem-memory.db` | 记忆库路径 |
| `offline` | `false` | 设 `true` 就完全不联网 |
| `webThreshold` | `0.45` | 本地证据低于这个值才联网 |

`webThreshold` 调高会更爱联网，调低更相信本地。默认 0.45 是标定出来的：真话题的证据分基本在 0.45 以上，无关问句在 0.41 以下。

---

## 开发

```bash
node --test test/parity.test.mjs test/server.test.mjs test/config.test.mjs
```

24 个用例。13 个把召回结果和 Python 版 zhmem 逐位对齐——命中的条目、证据分、总分三项都要一致；7 个跑 HTTP 那一层（播种、导入、静态文件、路径穿越）；4 个测配置文件解析（注释、引号、环境变量优先）。改检索逻辑之后跑这个，数字变了就是改坏了。

```
lib/text.js        分词、覆盖度、查询清洗
lib/synonyms.js    同义词折叠（膝盖→膝、肚子→腹部）
lib/store.js       SQLite 存储 + 打分
lib/kb.js          知识库加载与导入
lib/retriever.js   本地/联网调度
lib/web.js         联网与图片（DuckDuckGo + Wikimedia，都不要 key）
lib/tools.js       十个工具的定义
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
