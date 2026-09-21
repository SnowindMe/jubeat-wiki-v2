# jubeat 音乐魔方 WIKI v2 · 需求规格（requirements）

> **本文档是本轮的唯一契约来源。** 实现（t4 数据层 / t6 核心页 / t7 资料页）、验证（t8）、评审（t10）都以本文为准；与本文冲突的旧约定一律以本文为准。
> 版本：r1（round 1）｜作者：architect｜落地路径：`jubeat-wiki-v2/docs/requirements.md`
> 参考（只读，不得修改）：`jubeat-wiki/`（旧 Svelte 5 实现 + `docs/` 报告）、顶层 `all_songs_502.json` 等数据源。

---

## 0. 范围与边界

### 0.1 本轮做什么（In Scope）

1. 新建独立工程 `jubeat-wiki-v2/`，**Astro 静态生成（SSG）**，全新信息架构与视觉语言。
2. 四个一级分区导航：**曲目库 / 数据 / 图鉴 / 关于**（见 §2）。
3. 曲目、定数、Jubility、充能、考据数据**全网重抓 + 逐条对账 + 重建**（数据层产物见 §6）。
4. 全部页面静态预渲染（含每曲一页的曲目详情）。
5. Vercel 主站 + Cloudflare Pages 镜像，域名沿用 `byd-ub.top`。
6. 为下一轮的「用户投票制难度排行」预留数据模型与接口契约（见 §9）。

### 0.2 本轮不做什么（Out of Scope）

| 不做 | 说明 |
|---|---|
| 后端运行时 | 本轮 0 个函数 / 0 个数据库绑定，站点是**纯静态** |
| 用户账号 / 登录 / 云存档 | 不存储任何个人信息 |
| 用户投票、评论、排行榜 | 下一轮的事（本轮只预留，见 §9） |
| 管理后台 | 数据由仓库内 JSON 管控，改数据 = 改文件 + git 提交 |
| 站内搜索服务端 | 检索在构建期生成索引 + 客户端过滤 |
| 多语言 | 中文单语 |
| 深浅色主题切换 | 仅深色（见 §7） |
| 修改 `jubeat-wiki/` 旧工程 | **只读参考**；旧工程保持原样 |

### 0.3 术语速查

| 词 | 含义 |
|---|---|
| 曲目主键 | `songId`（见 §6.3） |
| 难度键 | `<songId>:<diff>`（见 §6.3） |
| 分区 | 一级导航的四个顶级分栏 |
| 源 | 一个独立的数据出处（remywiki / 官方曲库 / 项目内表 / …，见 §6.2） |
| 权威口径 | 某字段被采信的那个源；其余源作为并存值保留 |

---

## 1. 产品定位与设计原则

**定位**：jubeat 音乐魔方（国服 / WAHLAP 版）的**非官方中文资料站**。核心价值 = 「别处查不到的资料在这里能一次查到」。

四条设计原则（实现取舍的判据）：

1. **资料优先，装饰其次。** 页面主体是数据表与考据正文；签名视觉只在两处发力（见 §7.3）。
2. **每个数字都能回溯。** 任一字段都能说出「来自哪个源」；界面在字段粒度上标注来源（§6.6）。
3. **差异不抹平。** 多源冲突时并存展示并标注，不静默取一个值（§6.5）。
4. **无 JS 可读。** 静态 HTML 即完整内容，JS 只是增强（§8.3）。

---

## 2. 信息架构（四个一级分区）

### 2.1 全局导航模型

```
┌─ 顶栏（sticky，高度 56px）────────────────────────────────────┐
│ [4×4 徽标] jubeat 音乐魔方 WIKI   │  曲目库 ▾ │ 数据 ▾ │ 图鉴 ▾ │ 关于 ▾ │ [搜索] │
└───────────────────────────────────────────────────────────────┘
```

- 四个一级项**常驻**顶栏；桌面为横向四组，移动端折叠为抽屉（分组展开）。
- 一级项下有多个页面时，点击/悬停/聚焦展开**二级下拉**；`Esc` 关闭；`Enter` 进入首项；全部为原生 `<a>`，无 JS 也能展开（`<details>`/`:hover`/`:focus-within` 降级）。
- 当前分区高亮（`aria-current="page"` 打在具体页面上，一级项打 `data-active="true"`）。
- 二级页面带**面包屑**：`分区名 / 二级名 [ / 具体页]`。
- 曲目详情是**曲目库的子页**：顶栏高亮归到「曲目库」（旧站同此约定，见旧 `WikiNav.svelte`）。

### 2.2 分区一：曲目库

| 层级 | 页面 | 说明 |
|---|---|---|
| 二级 | 曲目库（列表） | 全库检索、筛选、排序、统计概览 |
| 三级 | 曲目详情 | 每曲一页静态页 |

- 二级结构：**单入口 + 下钻详情**，下拉里可放「常用筛选」快捷入口（按难度 / 按解禁池 / 仅 PICK UP）直达 `/songs/?level=…`。
- 统计概览（原旧站「统计总览」页）**并入**曲目库列表页的统计条（§5.2）。
- 导航行为：从任何页面点曲名 → 详情页；详情页「曲目库」面包屑回到列表并**保留来源筛选**（通过 `?back=` 或 `history.back()`）。

### 2.3 分区二：数据

| 二级 | 页面 | 说明 |
|---|---|---|
| Jubility 理论值 | `/jubility/` | 理论值总表 + 规则说明 |
| 隐藏曲充能 | `/unlock/` | 五池充能解禁清单 + 规则 |

- 下拉分组标题「数值与解禁」，两项并列。
- 与曲目库互链：曲目详情含 Jubility 段与获取方式段；两个数据页的每一行可跳曲目详情。

### 2.4 分区三：图鉴

| 二级组 | 页面 |
|---|---|
| 版本与更新 | 版本沿革 `/versions/`、更新情报 `/updates/` |
| 玩法与段位 | 玩法判定 `/gameplay/`、段位图鉴 `/dans/` |

- 下拉为**两级**：组标题不可点击，组下页面可点击。
- **术语表并入玩法判定页**（锚点 `#glossary`），不再单独成页（旧站 `#/glossary` 的独立入口取消）。

### 2.5 分区四：关于

| 二级 | 页面 | 说明 |
|---|---|---|
| 新手上路 | `/guide/` | 上手导览 + 如何读本站 |
| 关于本站 | `/about/` | 定位、免责、数据来源、纠错方式、致谢 |

- 「关于」下拉第二项附站点元信息（数据生成时间、构建版本）。

### 2.6 页面 → 分区映射总表

| 分区（一级） | 二级 | 路由 |
|---|---|---|
| 曲目库 | 曲目库列表 | `/songs/` |
| 曲目库 | 曲目详情 | `/songs/[songId]/` |
| 数据 | Jubility 理论值 | `/jubility/` |
| 数据 | 隐藏曲充能 | `/unlock/` |
| 图鉴 | 版本沿革 | `/versions/` |
| 图鉴 | 更新情报 | `/updates/` |
| 图鉴 | 玩法判定（含术语表） | `/gameplay/` |
| 图鉴 | 段位图鉴 | `/dans/` |
| 关于 | 新手上路 | `/guide/` |
| 关于 | 关于本站 | `/about/` |
| —（首页不属任何分区） | 首页 | `/` |

---

## 3. 路由表（完整）

**统一约定**：Astro `output: 'static'`、`trailingSlash: 'always'`、`build.format: 'directory'`；所有路径带尾斜杠，主机名规范 `https://byd-ub.top`。

| # | 路径 | 页面 | 预渲染 | 进导航 | 静态页数 | 生成方式 |
|---|---|---|---|---|---|---|
| 1 | `/` | 首页 | ✅ 是 | 是（徽标） | 1 | 静态 |
| 2 | `/songs/` | 曲目库（列表 + 筛选 + 统计概览） | ✅ 是 | 是（一级：曲目库） | 1 | 静态（筛选靠客户端） |
| 3 | `/songs/[songId]/` | 曲目详情 | ✅ 是 | 否（曲目库子页） | **每曲 1 页**（约 500） | `getStaticPaths()` 全量展开 |
| 4 | `/jubility/` | Jubility 理论值 | ✅ 是 | 是（一级：数据 → Jubility 理论值） | 1 | 静态 |
| 5 | `/unlock/` | 隐藏曲充能 | ✅ 是 | 是（一级：数据 → 隐藏曲充能） | 1 | 静态（池内清单可客户端切 Tab） |
| 6 | `/versions/` | 版本沿革 | ✅ 是 | 是（图鉴 → 版本沿革） | 1 | 静态 |
| 7 | `/updates/` | 更新情报 | ✅ 是 | 是（图鉴 → 更新情报） | 1 | 静态 |
| 8 | `/gameplay/` | 玩法判定（含术语表 `#glossary`） | ✅ 是 | 是（图鉴 → 玩法判定） | 1 | 静态 |
| 9 | `/dans/` | 段位图鉴 | ✅ 是 | 是（图鉴 → 段位图鉴） | 1 | 静态（版本切换客户端） |
| 10 | `/guide/` | 新手上路 | ✅ 是 | 是（关于 → 新手上路） | 1 | 静态 |
| 11 | `/about/` | 关于本站 | ✅ 是 | 是（关于 → 关于本站） | 1 | 静态 |
| 12 | `/404.html` | 404 | ✅ 是 | 否 | 1 | 静态 |
| 13 | `/sitemap-index.xml`、`/sitemap-0.xml` | 站点地图 | ✅ 是 | 否 | 自动 | `@astrojs/sitemap` |
| 14 | `/robots.txt` | 爬虫协议 | ✅ 是 | 否 | 1 | 静态 |
| 15 | `/search-index.json` | 客户端检索索引 | ✅ 生成 | 否 | 1 | 构建期生成（§8.8） |

**明确不存在的路由**（本轮）：`/stats/`（统计总览不单独成页）、`/glossary/`（并入 `/gameplay/#glossary`）、任何 `/api/*`（下一轮才加）、`/admin/`。

**深链与重定向**：
- 旧站 hash 深链形如 `/#/songs?id=10000036` **不做兼容**（v2 是新工程，无需承接旧 URL）；仅在 `/about/` 记录一句「v2 起路径结构变更」。
- 曲目详情路径只认 `songId`，不认曲名 slug（理由见 §6.3）。

---

## 4. 数据契约

> 本节是**字段级**契约：每个字段写清来源、权威口径、缺失时的表现。实现方不得自行猜测字段语义。

### 4.1 来源清单（S1–S10）

| ID | 源 | 内容 | 抓取/读取方式 | 备注 |
|---|---|---|---|---|
| S1 | **官方曲库（音乐魔方公开数据）** | 曲目全集、曲名、artist、曲绘、上线状态 | 抓取 + 与历史快照（`all_songs_*.json` 系列）比对 | 曲目**主表基准**（`songId` 由此而来） |
| S2 | **官方曲目 API（音游街侧）** | 每曲 BASIC 等级 `lv` | 抓取（旧站 `yinyoujie_songs_raw.json` 413 条为历史快照） | 只提供 BASIC，**绝不可当 EXT** |
| S3 | **remywiki** | 曲目考据、ADV/EXT 定数（`current`）、note 数、难度沿革、解禁池列表、机种归属 | 抓取曲目页 + 各机台页 + 列表页 | 考据类字段的**唯一来源** |
| S4 | **GENESA 相关官方文件** | 部分曲目（如 `Terminus`）的定数 | 项目内已归档产物 | 与 S3 冲突时**以 S4 为准** |
| S5 | **项目内表 1**（国框更新旧框歌进度） | 上线批次、库存曲目、`[N]` 写法 | 仓库内 TSV | 库存行**不并入**主表 |
| S6 | **项目内表 3/5**（Jubility 理论值 / pick up 10+） | jubility 条目、EXC 阶级、理论值 Normal/Hard、定数 | 仓库内 TSV | 逐条带 `source: xlsx3`/`xlsx5` |
| S7 | **项目内表 4**（跑图II歌曲详情） | 解禁池归属、池内顺序 | 仓库内 TSV | 池计数双轨口径见 §4.7 |
| S8 | **曲绘映射表** | `songId → 本地曲绘文件` | 项目内 JSON + 已归档 webp | 原图不可恢复时**禁止重建** |
| S9 | **段位数据** | festo/clan/prop 段位构成与通关条件 | 站内维护表（源自 bemaniwiki 等，见旧 `data/dans.json` 的 note） | 与曲目库通过曲名+难度关联 |
| S10 | **官方更新资讯** | 更新批次、日期、图文、来源 URL | 抓取资讯列表 | 更新情报页正文来源 |

**重抓要求（t2/t4）**：
- 构建时**不联网**。所有抓取产物先落盘到 `jubeat-wiki-v2/data/raw/`，再由构建脚本消费，保证可复现。
- 每个输入源记录 **sha256 + 抓取时间 + URL**，写入产物 `meta.json`（可核验可复现）。
- remywiki 匹配必须 **slug 优先 → 标题兜底 → 红链标题第三通道**；纯标题比对会产生大量假阳性（旧站实测 216 项假阳性）。
- 抓不到就是 `null`，**不猜、不造**。

### 4.2 曲目主表字段（`songs.json`）

| 字段 | 类型 | 权威口径 | 并存源 | 缺失表现 |
|---|---|---|---|---|
| `songId` | string | **S1**（官方曲库）；N/A 时由规则生成（§6.3） | — | 不允许为空 |
| `title` | string | **S1**（官方写法） | S3（remywiki 写法）、S5 | 不允许为空 |
| `titleNorm` | string | 构建期归一化产物（§6.3） | — | 派生 |
| `artist` | string \| null | **S1** | S3 | `null` |
| `bpm` | string \| null | **S1**（保留原始文本，如 `110-220`、复合串） | — | `null`（不推算） |
| `levels.bsc` | number \| null | **S2** | S3（箭头清洗后） | `null` |
| `levels.adv` | number \| null | **S3**（`current` 行） | S5、S6 | `null` |
| `levels.ext` | number \| null | **S3**（`current` 行） | S5、S6、S4（GENESA 曲目优先） | `null` |
| `levelMarks` | `{bsc,adv,ext}` 原始标记 | **S3** 的 `↑`/`↓` 前缀原样保留 | — | 无标记时为 `null` |
| `chartCount` | number | 派生（有值档数 0–3） | — | 派生 |
| `hasAltChart` | boolean | 由 S3 的 altCharts + S1 的 `[N]` 条目共同判定 | — | 缺省 `false` |
| `origin` | string \| null | **S3**（曲目最早出现机种）；不足时补全（§4.4） | 补全值记 `origin-patch` | 极端情况下 `"原机种待考"`（**不允许静默 `null`**） |
| `category` | string | 分类枚举：`old` / `new` / `crossover` / `original` / … | — | 不允许为空 |
| `isPickUp` | boolean | **S5/S6**（PICK UP 名单） | — | `false` |
| `limited` | boolean | **S1/S5** | — | `false` |
| `unlockPool` | string \| null | **S3 列表页**（池归属） | S7 | `null`（= 无需充能） |
| `poolPhase` | 1 \| 2 \| null | **S3** | S7 | `null` |
| `exchangeCost` | string \| null | **S1/S7** | — | `null` |
| `addedAt` | string \| null（`YYYY-MM-DD`） | **S5/S10**（上线日期） | — | `null` |
| `addedBatch` | string \| null | **S5/S10**（批次名） | — | `null` |
| `cover` | string \| null | **S8** | — | `null`（**不生成占位图伪造**；UI 用几何占位块） |
| `notecounts` | object \| null | **S3** | — | `null` |
| `levelHistory` | array | **S3** | — | `[]` |
| `trivia` | array | **S3** | — | `[]` |
| `songConnections` | array \| null | **S3** | — | `null` |
| `hasRemywiki` | boolean | 派生：**存在完整 remywiki 条目**（`remywiki !== null`） | — | 派生 |
| `sources` | string[] | 构建期记录该曲用过哪些源 | — | 非空 |

> ⚠️ **`hasRemywiki` 的判定不得用 `sources.includes('remywiki')`**（红链曲目的 `sources` 语义与旧实现不同，见 §4.6）。必须由「是否存在完整条目对象」派生。

### 4.3 Jubility 字段（`jubility.json`）

| 字段 | 类型 | 权威口径 | 缺失表现 |
|---|---|---|---|
| `entries[].title` | string | S6（表 3 优先，表 5 补充） | — |
| `entries[].diff` | `"Basic"｜"Advanced"｜"Extreme"` | S6（难度名归一：`Advance` → `Advanced`） | — |
| `entries[].constant` | number \| null | S6 | `null` |
| `entries[].excClass` | string \| null | S6（表 3） | `null`（表 5 来源条目本就为空） |
| `entries[].valueNormal` | number \| null | S6 | `null` |
| `entries[].valueHard` | number \| null | S6 | `null` |
| `entries[].section` | `"COMMON"｜"PICK UP"` | S6（段名正则须容忍 `Pick Up SONG` 写法） | — |
| `entries[].source` | string | 溯源（`xlsx3` / `xlsx5`） | 非空 |
| `entries[].songId` | string | **由难度键解析得到**（§6.3） | 非空 |
| `entries[].difficultyKey` | string | `<songId>:<diff>` | 非空 |
| `entries[].hasAltChart` / `titleStripped` / `resolvedAs` | — | 解析姿态记录 | — |
| `maxNormal` / `maxHard` | number | 派生（表内最大值） | — |
| `updatedAt` / `source` | — | 元信息 | — |

**规则**：每条必须能跳到曲目详情（`songId` 100% 命中）；解析优先级为「`base [ 2 ]` 独立条目 → 剥离后原曲」，不得让 `[2]` 条目回落到原曲难度。

### 4.4 充能池字段（`pools.json`）

| 字段 | 类型 | 权威口径 | 说明 |
|---|---|---|---|
| `pools.<POOL>.phase1[]` | string[] | S3 列表页（**顺序原样保留**） | CHERRY / KUMQUAT / LIME / BLUEBERRY / RAINBOW |
| `pools.<POOL>.phase2[]` | string[] | S3 | 同上 |
| `pools.<POOL>.phase1Window` | string \| null | S3 | 开放窗口文案 |
| `pools.<POOL>.phase2Note` / `phase2Detail` | — | S3 | 备注与逐条等级兜底 |
| `poolsUnmatched[]` | object[] | 差额登记（见下） | 逐条列出「无独立曲目对象」的条目 |
| `poolCounts` | number | **本站口径**：曲目库中实际归属数 | 列表面板按此计数 |
| `poolRawCounts` | number | **remywiki 列表页口径**（把独立第二谱面单列计入） | 与上者的差额 = `poolsUnmatched` 条数 |
| `poolRawTotal` / `poolActualTotal` | number | 两个合计 | 双轨保留 |

**铁律**：池总数两口径**并存展示**（面板主数字用「本站口径」，附注写明另一口径与差额条数），**不做静默抹平**。

### 4.5 段位字段（`dans.json`）

| 字段 | 类型 | 权威口径 | 说明 |
|---|---|---|---|
| `config.scoreMax` | number | S9 | 单曲满分（如 1,000,000） |
| `config.pass.total` / `config.pass.rate` | number | S9 | 通关合计与达成率 |
| `dans[].id` | string | S9 | 形如 `festo-1`、`clan-3`、`prop-7`（**稳定键，勿改**） |
| `dans[].version` | `festo`｜`clan`｜`prop` | S9 | 版本轴 |
| `dans[].name` | string | S9 | 段位名 |
| `dans[].mode` | string | S9 | 曲制（如 `normal`） |
| `dans[].criterion` | `score`｜… | S9 | 通关判据类型 |
| `dans[].songMin` | number \| null | S9 | 单曲门槛 |
| `dans[].songs[]` | object[] | S9 | 每项：`title` / `diff` / `level` / `hidden` / `image` |

**关联要求**：`dans[].songs[].title + diff` 必须能解析到曲目主表的 `difficultyKey`；解析失败**不得静默丢弃**，须记入构建日志与 `unmatched` 区块。

### 4.6 考据与更新情报

| 产物 | 字段 | 权威口径 |
|---|---|---|
| `song-details.json → details[<songId>]` | `remywiki`（完整条目）/ `notecounts` / `levelHistory[]` / `altCharts` | S3 唯一 |
| `updates.json` | `date` / `batch` / `songs[]` / `note` / `url` | S10 |
| `release` | 机台发售信息（时间、地点、代理） | S10 + 官方公告 |
| `meta.json` | `generatedAt` / `sources[]`（sha256 + 抓取时间 + URL）/ `counts` | 构建期 |

**`sources` 语义表（必须遵守）**：

| 取值 | 含义 |
|---|---|
| `remywiki` | **有完整考据条目**；与「`remywiki` 对象非 null」严格等价 |
| `remywiki.index` | 仅来自 remywiki 列表页/索引（红链，无独立条目） |
| `all_songs` / `api` / `genesa` / `origin-patch` / `cover-map` / `xlsx1..5` / `remywiki.altCharts` | 该字段使用过该源 |

### 4.7 冲突登记与界面标注（**核心**）

**冲突单条结构**（`conflicts.json`）：

```json
{
  "id": "c-0001",
  "songId": "990000008",
  "difficultyKey": "990000008:adv",
  "field": "level",
  "authoritative": { "value": 7, "source": "genesa" },
  "alternates": [ { "value": 6, "source": "remywiki", "raw": "6" } ],
  "severity": "value-diff | notation-diff | alias",
  "note": "GENESA 官方文件优先；remywiki 记于早期版本",
  "evidenceUrl": "…"
}
```

**判定规则**：

| 情形 | 处理 |
|---|---|
| 归一化后**完全等价**（如 remywiki `↓6` vs 官方 `6`；`Advance` vs `Advanced`） | **不登记冲突**，只保留 `levelMarks` 原始标记用于展示 |
| 归一化后**值不同** | 登记冲突；界面按权威口径显示主值，并带**来源徽标** |
| **曲名写法不同**（如 `け`/`げ`、空格差异、`[N]` 三种写法） | 登记为 `alias` 类型；主表采信 S1 写法；详情页展示「其他来源写法」 |
| **口径不同**（如池总数 179 vs 185） | 双轨并存展示 + 附注说明差额构成（§4.4） |

**界面标注规范（字段粒度，必须实现）**：

1. 存在并存值的字段，值后渲染一个 **来源徽标**（`remy` / `官方` / `表3` / `表5` / `GENESA`），徽标 `title`/`aria-label` 写明来源全称。
2. 徽标**可键盘聚焦**（`tabindex="0"`），聚焦或点击展开一个 popover，列出**全部来源的取值**与差异说明。
3. 无并存的字段不显示徽标（避免视觉噪音）。
4. 页面级别的「数据来源」区块列出本页用到的源与生成时间。
5. **绝不**在两值都合理时静默选一个而不标注。

### 4.8 已知数据缺口（**记录，不当 bug 修**）

以下缺口必须**照实呈现**（`null` / 「暂无数据」），禁止推断补全或伪造：

| 现象 | 处理 |
|---|---|
| 无 BPM | 显示「—」，不推算 |
| 无曲绘 | 几何占位块（16 格纹理），**不生成伪图** |
| 三档不齐（官方只上 BASIC） | 缺的档显示「未上线」而非 `0` |
| 无 remywiki 考据 | 详情页考据区显示「暂无考据资料」，并**隐藏**该区块的骨架 |
| `excClass` / 理论值为空 | 显示「—」，不填 0 |
| 库存曲目（尚未上线） | **不进主表**；仅在更新情报页作为「待上线」说明 |

**构建自检**：任一源解析出的**逐表条数**必须断言（不接受「总数 ≥ N」这类粗粒度断言 —— 旧站曾因单表少 1 条而总量检查仍通过）。

---

## 5. 页面清单与每页必备区块

> 「必备区块」= 缺失即视为未完成，t8 逐页断言。

### 5.1 `/` 首页

| 区块 | 内容 | 数据来源 |
|---|---|---|
| ① Hero | 站名 + 一句话定位 + **4×4 触控面板签名元素**（暗格 + 3 个点亮格对应三难度）+ 非官方免责声明 | 静态 |
| ② 统计概览 | 总曲数、三档有值数、版本数、段位数、充能池数（**承接原「统计总览」页，不另设页**） | `meta.json.stats` |
| ③ 四分区入口 | 4 张入口卡，标题与副标题对应四分区，点击进各分区首屏 | 静态 |
| ④ 最新更新 | 最近 3–5 个更新批次（日期 + 标题）→ `/updates/` | `updates.json` |
| ⑤ 版本速览 | 历代机台横向年表（9 代 + 音乐魔方）→ `/versions/` | `versions.json` |
| ⑥ 快捷检索 | 搜索框（`Ctrl`/`⌘ + K` 聚焦，`Esc` 清空）→ 跳曲目库 | `search-index.json` |
| ⑦ 关于本站数据 | 生成时间、源清单入口、免责与纠错方式 | `meta.json` |

### 5.2 `/songs/` 曲目库

| 区块 | 内容 |
|---|---|
| ① 页头 | 标题 + 结果计数（`共 N 首 / 筛选后 M 首`） |
| ② 筛选栏 | 难度档、等级区间、原机种、解禁池、分类、PICK UP、有无考据；**筛选状态写入 URL query**（可分享、可后退） |
| ③ 排序 | 曲名 / 最高等级 / 上线日期 / 批次 |
| ④ 统计概览条 | 分类分布、等级分布、池分布、原机种分布、数据完整度（**原「统计总览」页并入此处**） |
| ⑤ 结果表 | 每行：曲绘缩略、曲名、artist、BSC/ADV/EXT（带来源徽标）、原机种、池、上线批次、（`[2]` 标记） |
| ⑥ 空状态 | 「无匹配曲目」+ 一键清空筛选 |
| ⑦ 分页/长列表 | 长列表须保持滚动性能（§8.4） |
| ⑧ 移动端降级 | ≤768px 转卡片列表，字段按优先级裁剪，**不横向滚动** |

### 5.3 `/songs/[songId]/` 曲目详情（每曲一页）

| 区块 | 内容 |
|---|---|
| ① 头部 | 曲绘（或占位块）、曲名、artist、BPM、原机种、分类徽章、`[2]` 谱面提示 |
| ② 谱面难度表 | 三档等级 + 定数 + 原始升降标记 + note 数 + **来源徽标** |
| ③ 难度沿革 | `levelHistory` 时间线（如无则隐藏） |
| ④ 获取方式 | 解禁池 / 阶段 / 兑换费用 / 上线批次 |
| ⑤ 段位索引 | 该曲出现的全部段位（段位名 + 难度 + 等级）→ 跳段位图鉴 |
| ⑥ Jubility | 若在表内：EXC 阶级 + 理论值 Normal/Hard + 排名位置 |
| ⑦ 考据 | remywiki `trivia` / `songConnections`（无则显示「暂无考据资料」） |
| ⑧ 数据来源与冲突 | 本页用到的源、生成时间、该曲的冲突登记条目 |
| ⑨ 相邻导航 | 上一首 / 下一首（按当前排序口径） |
| ⑩ 元信息 | 每页唯一 `<title>`（`曲名 · …`）、description、canonical、JSON-LD（可选） |

### 5.4 `/jubility/` Jubility 理论值

| 区块 | 内容 |
|---|---|
| ① 规则说明 | jubility 是什么、EXC 阶级、理论值 Normal/Hard 的定义与计算口径 |
| ② 总表 | 全部条目：曲名（可跳详情）、难度、定数、EXC 阶级、理论值 Normal、理论值 Hard |
| ③ 筛选 | 难度、CLASS、区间排序 |
| ④ 标尺 | 表内最大值（`maxNormal` / `maxHard`）醒目展示 |
| ⑤ 来源标注 | 每条带 `source`（表 3 / 表 5） |
| ⑥ 缺口说明 | 理论值为空条目的条数与原因说明 |

### 5.5 `/unlock/` 隐藏曲充能

| 区块 | 内容 |
|---|---|
| ① 规则说明 | 充能机制、五个池的含义、phase1/phase2 |
| ② 池 Tab | CHERRY / KUMQUAT / LIME / BLUEBERRY / RAINBOW（**Tab 计数 = 本站口径**） |
| ③ 池内清单 | 按 remywiki 原始顺序；`phase1` / `phase2` 分组；无独立条目者用 `phase2Detail` 等级兜底 |
| ④ 窗口与备注 | `phase1Window` / `phase2Note` |
| ⑤ 双轨计数附注 | 明写「本站口径 N 首 / 列表页口径 M 首，差额 K 条（逐条见下）」+ 差额列表 |
| ⑥ 兑换费用 | 有值则显示 |

### 5.6 `/versions/` 版本沿革

| 区块 | 内容 |
|---|---|
| ① 年表 | 2008–至今，历代机台按时间排列（jubeat → … → beyond the Ave. → 音乐魔方） |
| ② 机台详情 | 选中机台：登场年份、曲目数（本站收录）、特征说明、机台 Logo |
| ③ 代表曲 | 该机种原机种的曲目列表（跳曲目库按 `origin` 筛选） |
| ④ 互链 | 与曲目库「原机种」筛选双向可达 |

### 5.7 `/updates/` 更新情报

| 区块 | 内容 |
|---|---|
| ① 机台发售信息 | 发售时间、地点、代理（WAHLAP 等） |
| ② 更新时间线 | 全部批次，按日期**升序**（早 → 晚）；每批：日期、批名、收录曲列表、备注、来源链接 |
| ③ 待上线说明 | 库存曲目（尚未上线）的说明与清单入口（**不混入曲目库**） |
| ④ 来源 | 每条带原始资讯 URL |

### 5.8 `/gameplay/` 玩法判定（**含术语表**）

| 区块 | 内容 |
|---|---|
| ① 判定方式速查 | PERFECT / GREAT / GOOD / POOR 的判定宽度与得分影响 |
| ② 得分与评级 | 总分构成、EXC 判定、COURSE MODE 的通关条件 |
| ③ 界面符号 | 机台 UI 符号与本站图例的对应 |
| ④ 术语表（`#glossary`） | **旧站独立页并入此处**：按分类分组，每条：术语、读法、释义；组标题作为锚点 `#glossary-<cat>` |
| ⑤ 检索 | 术语表搜索框（复用全站键盘检索） |
| ⑥ FAQ | 新手高频问题（跳「新手上路」） |

### 5.9 `/dans/` 段位图鉴

| 区块 | 内容 |
|---|---|
| ① 版本切换 | festo / clan / prop（Tab 或分段控件） |
| ② 段位列表 | 全部段位（festo 初段–十段/皆伝/指神；clan 12 门；prop 33 课程） |
| ③ 段位详情 | 曲目构成（3 曲制 / 5 曲制）、每曲难度与等级、隐藏曲标记、曲绘 |
| ④ 通关条件 | 合计分 / 达成率 / 单曲门槛（`config.pass`、`songMin`） |
| ⑤ 跳转 | 每曲可跳曲目详情 |

### 5.10 `/guide/` 新手上路

| 区块 | 内容 |
|---|---|
| ① 什么是 jubeat | 4×4 面板玩法一段式说明 |
| ② 如何读本站 | 四分区导览（每分区一段 + 直达链接） |
| ③ 常用术语速查 | 精选 10–15 条 + 跳 `/gameplay/#glossary` |
| ④ 数据从哪来 | 源清单与权威口径摘要（跳 `/about/` 詳解） |
| ⑤ 常见问题 | FAQ |
| ⑥ 纠错入口 | 如何报告错误 |

### 5.11 `/about/` 关于本站

| 区块 | 内容 |
|---|---|
| ① 定位与免责 | 非官方站点声明、与 KONAMI / WAHLAP 无关 |
| ② 数据来源 | S1–S10 清单、权威口径、生成时间、指紋 |
| ③ 冲突与缺口政策 | 「多源并存 + 界面标注」「记录不伪造」 |
| ④ 纠错方式 | 反馈渠道（如 GitHub Issues） |
| ⑤ 致谢与许可 | remywiki 等来源致谢 |
| ⑥ 变更记录 | v1 → v2 的路径与结构变化说明 |

### 5.12 `/404.html`

- 站点风格 404：说明文案 + 四分区入口 + 搜索框；不自动跳转。

---

## 6. 曲目主键与难度键（**稳定形式，下一轮复用**）

### 6.1 为什么必须定义稳定键

曲名**不是**唯一键。已知三类不稳定性：`\n` 字面换行、别名/异写（`け`↔`げ`）、`[N]` 三种写法（`Chorus [ 2 ]` / `Chorus[2]` / 无）。旧站曾因按标题匹配出现错跳。下一轮的**用户投票**必须挂在一个不会随曲名写法漂移的键上。

### 6.2 `songId`（曲目主键）

**形式**：非空字符串，取以下之一，**永不复用/改写**：

| 形态 | 规则 | 示例 |
|---|---|---|
| 官方数字串 | S1 原样，避免前导零丢失（**字符串，不是 number**） | `10000036` |
| 音乐魔方新增块 | S1 原样 | `990000014`、`90000229` |
| remywiki 独有曲 | `rw-<slug>`，`slug` = remywiki 页面名小写化、非字母数字转 `-`、去除首尾 `-` | `rw-hopeful-frontier` |

**禁止**：用曲名、曲名 slug、`title` 的哈希作主键（曲名会漂移）。URL 只用 `songId`。

**归一化辅助键**（仅供匹配，不作主键）：`titleNorm` = NFKC → 空白折叠 → `trim` → 别名表替换 → `[ 2 ]`/`[2]` → `[2]` 定式。匹配顺序：`titleNorm` 精确 → 去空格 → 别名表 → 人工白名单；**假匹配黑名单**必须硬编码（如 `Glitter Flatter Scatter` ≠ `Glitter Cube`，`ZZ` ≠ `アモ`）。

### 6.3 `difficultyKey`（难度键）

**形式**：`<songId>:<diff>`，`diff ∈ {"bsc","adv","ext"}`（**小写三字母，永不使用 `Basic`/`EXTREME` 等显示名**）。

| 情形 | 键 |
|---|---|
| 常规三档 | `10000036:bsc` / `10000036:adv` / `10000036:ext` |
| `[2]` 第二谱面且已提升为独立条目 | 用其独立 `songId`：`90001021:ext` |
| `[2]` 第二谱面**未**提升为独立条目 | `<baseSongId>:<diff>:alt2`（如 `60000010:ext:alt2`） |

**约束**：
- 每个 `difficultyKey` 在库内**唯一**，且**永不回收**。
- 展示名与键分离：界面显示「曲名（EXTREME 10.9）」，数据里只认键。
- 「曲名+难度」的人类可读键 = `<titleNorm>|<diff>`；它**只用于与项目内表（表 3/5）对账**，不用于本站内部关联。

### 6.4 供下一轮投票复用的外键

- 投票目标：`difficultyKey`（字符串主键，可直接作为 D1 的外键列）。
- 提供一份**导出清单** `difficulty-index.json`：`[{ difficultyKey, songId, diff, title, constant }]`，供后端初始化与前端渲染。
- 该清单一旦发布，`difficultyKey` **不可变更**；曲名/定数变化不影响键。

---

## 7. 视觉语言约束（接口层）

> **责任划分**：具体视觉方向由 `t3`（方向稿）与 `t5`（设计系统冻结）定稿。本文只钉**必须满足的约束与接口**，避免实现期返工。

### 7.1 方向约束

1. **暗色机台面板**方向（沿用旧站已验证方向，v2 可演进但不得回退为浅色糖果风）。
2. **无投影层级**：层级靠面板亮度差 + 1px 拼缝表达。
3. **方角体系**：圆角 ≤ 8px，**禁止胶囊（999px）**。
4. **单一强调色**：一个「命中色」用于选中/聚焦/悬停；难度三色（BSC/ADV/EXT）固定且**只用于难度**。
5. **4×4 触控面板**为核心构图单位（Hero、空状态、占位图、分隔韵律）。

### 7.2 令牌契约（t5 冻结，实现方只消费）

- 所有设计令牌以 CSS 自定义属性暴露，统一前缀 **`--w-`**（与旧站兼容，便于对照参考实现）。
- 必备令牌族：表面层（`--w-bg` / `--w-panel` / `--w-panel-2` / `--w-seam`）、文字（`--w-ink` / `--w-ink-soft` / `--w-muted`）、强调（`--w-hit` / `--w-hit-deep`）、难度（`--w-bsc` / `--w-adv` / `--w-ext`）、圆角（`--w-r-*`）、间距（`--w-s-*`，4px 基数）、排版（`--w-font-*` / `--w-fs-*`）、布局（`--w-shell` / `--w-nav-h` / `--w-tap`）、动效（`--w-dur-*` / `--w-ease`）。
- 令牌定义在**单一文件**（如 `src/styles/tokens.css`），组件不得内联硬编码色值。
- 对比度要求见 §8.5。

### 7.3 签名元素（全站只在此发力）

1. **4×4 面板**：Hero 右侧真实比例 16 格，3 格点亮对应三难度。
2. **命中线（Hit-Line）**：列表行悬停/聚焦时，行顶部 1px 强调色亮线，250ms 衰减；同时承担「当前行」指示。

### 7.4 动效与性能

- 动效仅 120 / 200 / 320ms 三档；全部可被 `prefers-reduced-motion: reduce` 关闭。
- 不使用持续循环动画（旧站飘浮糖果装饰已删除）。
- 装饰性元素 `aria-hidden="true"`。

---

## 8. 非功能指标（逐条可度量）

> 每条给出**阈值 + 测量方法 + 测量环境**。t8 必须逐条给出证据（命令 + 原始输出/截图 + 数值）。

### 8.1 性能（Lighthouse，移动端）

| 指标 | 阈值 | 测量方法 |
|---|---|---|
| Lighthouse 移动端 Performance | **≥ 90** | Lighthouse CI / CLI，模拟 Moto G Power + Slow 4G，跑**首页、曲目库、一个曲目详情、段位图鉴**四页 |
| Lighthouse Accessibility | ≥ 95 | 同上 |
| Lighthouse Best Practices | ≥ 95 | 同上 |
| Lighthouse SEO | ≥ 95 | 同上 |

四页各自的 Performance 都必须 ≥90；报告数值留存。

### 8.2 核心 Web 指标（字段数据口径）

| 指标 | 阈值 | 测量方法 |
|---|---|---|
| **LCP** | **< 2.5s** | Lighthouse 移动端模拟，四页均满足；LCP 元素应为静态 HTML 内文本或直接 `<img>`，不得由 JS 注入 |
| CLS | < 0.1 | 同上 |
| TBT | < 200ms | 同上（本轮无重交互，天然满足） |
| TTFB | < 800ms（部署环境） | 生产 URL 实测 |

### 8.3 首屏无需 JS 可读（硬要求）

- **在浏览器禁用 JS 的条件下**，首页 / 曲目库 / 曲目详情 / 各资料页的首屏与主体内容**完整可读**（标题、统计、表格、正文均在 HTML 中）。
- 导航在无 JS 下可用（原生链接；下拉用 `<details>` 或 CSS `:hover`/`:focus-within` 降级）。
- 验证方法：禁 JS 加载各路由，断言关键文本存在于 DOM（旧站有同类断言脚本可借鉴思路）。
- JS 仅用于增强：筛选、搜索、Tab 切换、popover；这些功能的**静态默认态**必须已有可读内容（如 `/dans/` 默认渲染 festo 段位）。

### 8.4 资源预算

| 项 | 阈值 |
|---|---|
| 首屏 JS（gzip） | ≤ 30 KB |
| 单页 CSS（gzip） | ≤ 20 KB |
| 单曲详情页 HTML（gzip） | ≤ 40 KB |
| 首页图片总重（gzip） | ≤ 150 KB |
| 曲绘缩略图 | 单张 ≤ 30 KB（webp，按需尺寸） |
| 字体 | **不加载外部字体**（系统字体栈），零字体请求 |
| 外部第三方脚本 | **0**（无分析、无 CDN JS） |

### 8.5 无障碍（WCAG 2.1 AA）

- 正文文本对比度 ≥ 4.5:1；大字 ≥ 3:1；**难度色与强调色在深底上均须达标**（旧站设计系统已给出实测比值，可参考）。
- 全部交互元素键盘可达（Tab 序合理），焦点样式**可见**且不被裁切。
- 每页有 `skip to content` 链接；`<main>` / `<nav aria-label>` / 标题层级不跳级（h1→h2→h3）。
- 表格使用 `<th scope>`；表单控件有 `<label>`。
- 图标按钮有 `aria-label`；装饰元素 `aria-hidden`。
- 语言标记 `lang="zh-CN"`；`prefers-reduced-motion` 生效。
- 自动化：axe / Lighthouse a11y 无 `serious`/`critical` 级问题；另做键盘走查（Tab 走完首页与曲目库）。

### 8.6 SEO

- 每页唯一 `<title>`（`页面名 · 站名`）与 `meta[name=description]`（**非模板复读**，逐页可区分）。
- `link[rel=canonical]` 指向 `https://byd-ub.top` 对应路径（尾斜杠一致）。
- OG / Twitter Card 元信息（含曲目详情页的曲绘）。
- `sitemap`：`@astrojs/sitemap` 生成 `sitemap-index.xml`，**必须包含全部约 500 个曲目详情页**；`robots.txt` 指向 sitemap。
- 语义化 URL（`/songs/10000036/`），无查询串参与索引。
- 结构化数据：首页 `WebSite`，曲目详情 `MusicComposition` 或 `CreativeWork`（可选但推荐）。
- 中文内容 `lang="zh-CN"`；无重复内容页（曲目详情不得只有曲名差异的模板填充）。

### 8.7 响应式（375 / 768 / 1440）

| 档位 | 要求 |
|---|---|
| **375**（手机） | `document.documentElement.scrollWidth ≤ viewport + 1`（**无横向滚动**）；触控目标 ≥ 38px；导航为抽屉；宽表转卡片 |
| **768**（平板） | 同上无横向滚动；曲目库可保留表格但裁列或允许**容器内**横滚（页面本身不得横滚） |
| **1440**（桌面） | 内容容器居中（≤ 1240–1544px），不得出现超宽空行或表格溢出 |

验证：三档截图 + 滚动宽度断言（逐页断言 scrollWidth，不只测首页）。

### 8.8 检索与大数据量

- 构建期生成 `search-index.json`（曲名 / artist / 别名 / 术语），**按需懒加载**，不得进首屏关键路径。
- 曲目库列表与检索在客户端过滤，**首屏渲染完整静态表格**（SEO 与无 JS 双重要求的折中：静态输出全部行或分页静态输出）。
- `search-index.json` gzip 后 ≤ 200 KB；加载后再支持 `Ctrl/⌘+K` 即时过滤。

### 8.9 双平台构建一致（Vercel + Cloudflare Pages）

| 要求 | 阈值 |
|---|---|
| 构建命令与输出目录 | 两平台**同一命令、同一输出目录**（`npm run build` → `dist/`） |
| Node 版本 | 两平台锁定同一版本（`.nvmrc` / `engines`） |
| 产物一致性 | 同一 commit 在两平台构建后，**HTML 文件的文本内容一致**（去除构建时间戳等易变字段后逐文件比对）；断言脚本留存输出 |
| 路由可用性 | 两平台均能 200 命中全部路由（含随机抽样曲目详情）与 404 |
| 环境差异隔离 | 不得依赖平台特有环境变量决定输出；`generatedAt` 等易变值不得进入需要比对的产物 |
| 域名 | 主站 `https://byd-ub.top`（Vercel）；Cloudflare Pages 为镜像，canonical 统一指向主站域名 |

### 8.10 构建与可维护性

- 全站构建（含约 500 个曲目详情页）**≤ 8 分钟**（CI 环境），失败即非零退出。
- 数据层脚本**幂等**：连续两次构建产物 byte 级一致（时间戳除外）。
- 数据自检项全部通过才允许构建继续（失败 `exit 1`），断言须**逐表条数级**（§4.8）。
- 无 `console.error`；无死链（构建期对全部内部链接做一次可达性检查）。
- 零运行时依赖的生产 JS（Astro 静态输出，交互用少量原生脚本）。

---

## 9. 下一轮预留：用户投票制难度排行（Cloudflare 后端）

> 本轮**不实现**，但**数据模型与接口必须在此写定**，使下一轮无需改动 `difficultyKey` 与页面结构即可接入。

### 9.1 架构

- **Cloudflare Pages Functions**（`functions/` 目录，与静态站同源部署，同域名 `/api/*`）。
- **D1**：投票与聚合的持久层。
- **KV**：排行聚合的读缓存 + 简单限流计数。
- 静态站照常工作；**接口不可用时页面降级**为「本轮静态数据 + 社区评分暂不可用」提示（不得白屏）。

### 9.2 D1 数据模型（草案，字段名即契约）

```sql
-- 投票明细（一行 = 一次提交）
CREATE TABLE votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  difficulty_key TEXT    NOT NULL,      -- 本站难度键 "<songId>:<diff>[:alt2]"
  rating        INTEGER NOT NULL,        -- 1..5（难度主观评分）
  voter_hash    TEXT    NOT NULL,        -- 匿名设备/浏览器指纹的哈希，绝不存原始标识
  created_at    TEXT    NOT NULL,        -- ISO8601
  revised_at    TEXT,                    -- 同一 voter 改票时间
  ip_hash       TEXT,                    -- 限流用，哈希后
  UNIQUE(voter_hash, difficulty_key)     -- 一人一谱一票（改票 = UPSERT）
);
CREATE INDEX idx_votes_key ON votes(difficulty_key);
CREATE INDEX idx_votes_voter ON votes(voter_hash);

-- 聚合结果（读路径只查这张表）
CREATE TABLE rating_agg (
  difficulty_key TEXT PRIMARY KEY,
  vote_count     INTEGER NOT NULL DEFAULT 0,
  rating_sum     INTEGER NOT NULL DEFAULT 0,
  rating_avg     REAL    NOT NULL DEFAULT 0,
  rating_dist    TEXT    NOT NULL DEFAULT '{}', -- JSON: {"1":n,...}
  wilson_lower   REAL    NOT NULL DEFAULT 0,    -- 置信区间下界（防小样本霸榜）
  updated_at     TEXT    NOT NULL
);

-- 排行快照（可选，按榜单维度缓存）
CREATE TABLE rank_snapshot (
  board        TEXT NOT NULL,   -- 'hardest' | 'easiest' | 'controversial' | 'most_voted'
  difficulty_key TEXT NOT NULL,
  score        REAL NOT NULL,
  rank         INTEGER NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (board, difficulty_key)
);

-- 内容纠错（可选的轻量反馈，与投票共用鉴权）
CREATE TABLE reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type    TEXT NOT NULL,   -- 'song' | 'dans' | 'jubility' | 'page'
  target_key     TEXT NOT NULL,   -- songId 或 difficultyKey 或路径
  field          TEXT,
  message        TEXT NOT NULL,
  reporter_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
);
```

**键约束**：`difficulty_key` 的取值域 = 本轮导出的 `difficulty-index.json`（§6.4）。服务端必须**校验键存在**（用构建期导出的白名单表或 KV 缓存集合），拒绝未知键。

### 9.3 KV 用途

| 键 | 值 | 用途 |
|---|---|---|
| `rank:<board>:v<n>` | 排行 JSON 数组 | 读缓存（TTL 60–300s），避免每次查询打 D1 |
| `rate:<ipHash>:<minute>` | 计数 | 简单限流（每 IP 每分钟 N 次写） |
| `allow:dkeys` | 难度键集合 | 键白名单（由构建产物同步） |

### 9.4 接口契约（下一轮实现）

| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| `GET` | `/api/difficulty/boards?board=hardest&limit=100` | 难度排行（升/降/争议度/最多人评） | 只读，走 KV 缓存 → 回源 D1 → 异步回填 |
| `GET` | `/api/difficulty/:difficultyKey` | 单谱聚合（票数、均值、分布、我的票） | 无票时返回 `vote_count: 0` |
| `POST` | `/api/difficulty/:difficultyKey/vote` | 提交/修改投票 | body `{ rating: 1..5 }`；匿名 `voter_hash` 由服务端派生并下发 HttpOnly Cookie；限流 |
| `GET` | `/api/rank/me` | 我的投票记录 | 用于「我评过的谱面」 |
| `POST` | `/api/report` | 内容纠错 | 限流 + 长度校验 |
| `GET` | `/api/health` | 健康检查 | 返回版本与键白名单条数 |

**通用要求**：JSON 返回；错误体 `{ error: { code, message } }`；CORS 同源；写接口需 `Origin` 校验；响应带 `Cache-Control`（读接口可缓存，写接口 `no-store`）。

### 9.5 本轮必须为下一轮预留的静态接口点

1. **数据字段预留**：曲目数据模型保留 `community: { ratingAvg: null, voteCount: 0 }` 字段（本轮恒为 `null` / `0`，UI 显示「暂无社区评分」）。
2. **路由预留**：`/rank/`（用户投票难度排行）页面路由已在 IA 中预留为「数据」分区的第三个二级项，**本轮不生成页面**，但导航与数据结构不得与之冲突。
3. **键不变性**：`difficultyKey` 一经导出即为下一轮的外键，**不得在本轮之后重新定义**。
4. **部署形态**：本轮 `vercel.json` / `wrangler` 配置须为「静态 + 后续挂 Functions」留出空间（不锁定纯静态假设，如 Cloudflare Pages 项目已按 `functions/` 约定预留目录名说明）。

### 9.6 排行口径（下一轮参考，先写清楚）

- 榜单排序使用 **Wilson 置信区间下界**（而非裸均值），避免 1 票 5 星霸榜。
- 展示时必须同时给出**票数**，票数低于阈值（如 <10）的谱面标注「样本不足」。
- 榜单页必须与本站权威定数并列显示，并明确区分「官方定数」与「社区主观评分」。

---

## 10. 验收清单（t8 / t10 使用）

### 10.1 结构类

- [ ] 四分区一级导航在全部页面可用，且每页可通过导航到达。
- [ ] §3 路由表中「预渲染 ✅」的路由在产物中都有对应静态 HTML（含全部曲目详情页）。
- [ ] 曲目详情页数 = 曲目主表条数（抽样 20 首验证内容正确、无串页）。
- [ ] 不存在 `/stats/`、`/glossary/` 独立页；统计概览出现在首页与曲目库；术语表出现在 `/gameplay/#glossary`。
- [ ] `/guide/` 与 `/about/` 存在且内容完整（非占位）。

### 10.2 数据类

- [ ] 每个曲目详情页的难度值可回溯到 `sources`（抽 10 首，含 `[2]` 谱面、GENESA 冲突曲、remywiki 独有曲、无曲绘曲各至少 1 首）。
- [ ] 冲突登记条目在界面上有来源标注（§4.7）；随机抽 3 条冲突验证徽标与 popover。
- [ ] `difficultyKey` 全库唯一，且与 `difficulty-index.json` 一致。
- [ ] 池计数双轨（179 vs 185 同构口径）在充能页同时出现，差额条数可见。
- [ ] 缺口数据展示为 `null` / 「待考」，**未伪造**（重点核对无曲绘、无 BPM、无考据三类）。
- [ ] 数据自检逐表条数断言全部通过（构建日志留存）。

### 10.3 非功能类

- [ ] §8.1 四页 Lighthouse 移动端 Performance ≥ 90（附报告数值）。
- [ ] §8.2 LCP < 2.5s（四页）。
- [ ] §8.3 禁 JS 后各页主体内容可读（断言 + 截图）。
- [ ] §8.5 a11y AA：自动化无 serious/critical + 键盘走查通过。
- [ ] §8.6 每页 title/description 唯一、canonical 正确、sitemap 含全部曲目详情页。
- [ ] §8.7 375 / 768 / 1440 三档逐页 scrollWidth 断言通过（附截图）。
- [ ] §8.9 两平台构建产物一致（断言脚本输出留存）。
- [ ] §8.4 资源预算达标（构建产物体积报告）。

### 10.4 四个原始痛点复核（t10 必查）

1. **导航臃肿**：旧站 10 项顶栏在 901–981px 区间被裁切 → v2 必须四分区 + 下拉，任意宽度不溢出。
2. **数据不可回溯**：旧站前端只能看到合并后的值 → v2 必须字段级来源标注。
3. **视觉与主题脱节**：旧站浅蓝糖果风 + 飘浮装饰 → v2 必须暗色机台面板、无持续动画、无胶囊。
4. **后端包袱**：旧站带 D1/KV/账号/后台 → v2 本轮纯静态，且下一轮后端只承载投票（§9），不得复活账号体系。

---

## 11. 命名与文件约定（实现方遵循）

```
jubeat-wiki-v2/
├─ docs/requirements.md          ← 本文档（唯一契约来源）
├─ docs/design-system.md         ← t5 产物（视觉令牌与组件规范）
├─ data/raw/                     ← 各源原始抓取产物（含 sha256 记录）
├─ data/generated/               ← 构建期产出的规范数据（见下）
├─ scripts/                      ← 数据构建与自检脚本（幂等）
├─ src/pages/                    ← Astro 路由（路径即 §3 路由表）
├─ src/components/               ← 组件（分区前缀命名）
├─ src/styles/tokens.css         ← 设计令牌单一来源
├─ public/                       ← 静态资源（曲绘、robots.txt、404）
└─ dist/                         ← 构建输出（两平台同源）
```

**规范数据产物**（`data/generated/`）：

| 文件 | 内容 | 消费者 |
|---|---|---|
| `songs.json` | 曲目主表（§4.2） | 曲目库、详情页、统计 |
| `song-details.json` | 考据与谱面细节（按 `songId` 索引） | 详情页 |
| `jubility.json` | Jubility 条目（§4.3） | `/jubility/`、详情页 |
| `pools.json` | 充能池与双轨计数（§4.4） | `/unlock/` |
| `dans.json` | 段位（§4.5） | `/dans/`、详情页段位索引 |
| `versions.json` | 机台年表 | `/versions/`、首页 |
| `updates.json` | 更新批次 | `/updates/`、首页 |
| `gameplay.json` | 判定/得分规则 + 术语表 | `/gameplay/` |
| `conflicts.json` | 冲突登记（§4.7） | 全站来源标注 |
| `difficulty-index.json` | 难度键清单（§6.4） | 下一轮后端 |
| `stats.json` | 统计概览（首页与曲目库共用） | 首页、曲目库 |
| `meta.json` | 生成时间、源指纹、计数 | `/about/`、自检 |

**约定**：
- 生成产物**提交进仓库**（构建时可离线复现）；`data/raw/` 同样入库。
- 命名统一 `camelCase` 字段；枚举值统一小写英文（难度键用 `bsc/adv/ext`，显示名由前端映射）。
- 任何字段缺失用 `null`（**不用空字符串、不用 0 代替未知**）。

---

## 12. 明确的口径判定表（易错点，实现前必读）

| # | 易错点 | 正确做法 |
|---|---|---|
| 1 | 把官方 API 的 `lv` 当 EXT | `lv` **只是 BASIC**；ADV/EXT 来自 remywiki `current` |
| 2 | remywiki 的 `↑`/`↓` 前缀导致 `parseFloat` 得 `NaN` | 先剥离箭头再解析；原始标记存入 `levelMarks` 供展示 |
| 3 | remywiki `current` 取「最后一行」 | 必须取 **`game === currentGame` 精确匹配**的那行 |
| 4 | `Advance` 与 `Advanced` 视为不同难度 | 难度名归一（`Advance` → `Advanced`） |
| 5 | PICK UP 段名写作 `Pick Up SONG` 导致整段丢失 | 正则容忍 `Pick Up( SONG)?`，并**逐段条数断言** |
| 6 | 池列表错位行（列塌陷）被整行丢弃 | 识别「首列为空 + 第三列是等级串」的错位行 |
| 7 | 红链曲目被当成「有考据」 | 红链记 `remywiki.index`；有无考据看条目对象是否为 `null` |
| 8 | 池总数两口径被抹平成一个 | 双轨并存 + 差额逐条登记 |
| 9 | 用曲名匹配导致错跳（`Glitter*`、`ZZ`/`アモ`） | 走 `titleNorm` + 别名表 + 假匹配黑名单；跳转一律用 `songId` |
| 10 | 曲绘缺失时生成占位图冒充 | 用几何占位块，**不伪造图片** |
| 11 | 库存曲目（未上线）混进曲目库 | 库存行**不并入**主表，仅在更新情报页说明 |
| 12 | `[2]` 谱面解析回落到原曲难度 | 先匹配独立条目；无条目时用 `alt2` 后缀键，绝不回落原曲 |
| 13 | 只做总量断言（`总数 >= 450`） | 必须**逐表条数**断言（旧站曾因此漏掉单表少 1 条） |

---

## 13. 附：关键数字基线（用于自检参照，最终以 t2/t4 重抓结果为准）

| 项 | 旧站基线 | 说明 |
|---|---|---|
| 曲目总数 | 500 | 官方库 494 ∪ remywiki 独有 6（去别名后） |
| remywiki 收录 | 304 | 其中约 272 有独立条目，余为红链 |
| Jubility 条目 | 91 | 表 3（60）+ 表 5 新增（31） |
| 充能池 | 5 池 / 本站口径 179 / 列表页口径 185 | 差额 6 条为未提升的 `[2]` 谱面 |
| 段位 | 57 | festo + clan + prop 合计 |
| 更新批次 | 19 | 按日期升序 |
| 曲目详情静态页 | ≈ 曲目总数 | 每曲一页 |

> 若重抓后数字变化（新曲上线、源修订），**以新数字为准**，但必须同步更新本节与 `meta.json` 计数，并在 `conflicts.json` / 自检日志中留痕。

---

*本文档为 r1 版本。任何对本文的修改都必须由 architect 出具新修订并在 `t10` 评审中说明变更原因。*
