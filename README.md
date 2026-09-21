# jubeat 音乐魔方 WIKI v2

以 Astro 构建的纯静态 WIKI。站点采用 **Blue Candy Cabinet** 蓝白糖果机台视觉与正式授权 Logo；构建、预览和已提交的数据均不依赖运行时联网。

- 静态输出：`dist/`
- Node：`>=20`（见 `package.json`；锁定依赖后建议使用 `npm ci`）
- 数据口径与缺口：`data/data-meta.json`、`data/data-conflicts.json`
- 最终静态验收证据：`docs/static-final-evidence.json`

## 数据来源说明（克隆后必读）

本仓库只包含源码、构建脚本与文档。**曲目清单、定数、Jubility、充能池、考据与曲绘属于第三方版权资料，未纳入版本库**，因此首次克隆后 `data/` 与 `public/jackets/` 是空的，直接执行 `npm run build` 会因缺少数据而失败。

受排除的路径包括：

- `data/songs.json`、`data/difficulty-index.json`、`data/jubility.json`、`data/unlock.json`
- `data/data-meta.json`、`data/data-conflicts.json`、`data/audit-report.md`、`data/_audit/`
- `public/jackets/`（492 张曲绘）

需要完整构建时，请从相邻的 `../jubeat-wiki/` 快照与审计产物用 `scripts/build-data.mjs` 再生成上述文件，再执行构建：

```sh
node scripts/build-data.mjs
npm run verify:data
npm run build
```

数据口径与缺口以 `data/data-meta.json`、`data/data-conflicts.json` 为准；字段缺失保持 `null`，不得把缺口推断成事实。

## 本地开发

在本目录执行：

```sh
npm ci
npm run dev
```

Astro 会输出本地开发地址。需要以生产构建预览时：

```sh
npm run build
npm run preview
```

## 构建与静态自检

```sh
npm run verify:data
npm run build
npm run verify:acceptance
npm run verify:static-final
```

其中 `build` 生成 `dist/`；`verify:acceptance` 校验部署配置、搜索索引、曲绘预算、sitemap 与无 JS 静态正文；`verify:static-final` 对已生成的 `dist/` 进行终验并更新 `docs/static-final-evidence.json`。当前最终静态证据为 72 项通过、0 项失败；浏览器历史证据不可恢复，未被表述为本轮已执行的浏览器验收。

## 数据再生成（离线）

已提交的 `data/*.json` 是可直接构建的交付数据。仅在旧站历史快照与本轮审计文件均齐备时，才在本目录运行：

```sh
node scripts/build-data.mjs
npm run verify:data
npm run build
npm run verify:static-final
```

该脚本从相邻的 `../jubeat-wiki/` 历史快照和 `data/_audit/out/` 读取数据，并会重建 `public/jackets/` 与 `data/*.json`；它不联网。请先审阅 `data/data-meta.json` 的来源哈希和 `data/data-conflicts.json` 的冲突登记，禁止把 `null` 缺口推断成事实。

## 曲目 URL 规则

- 数字 `songId` 输出为 `/songs/<songId>/`，例如 `/songs/10000036/`。
- 非数字的 `title:` 型 ID 使用可逆的 Windows 安全编码：`/songs/id-<Unicode 码点十六进制，以 -> 连接>/`。

原始 `songId` 保留在 `data/songs.json` 和构建出的 `dist/search-index.json`；URL 编码不会改写数据真值。

## 部署（只生成静态站点，不含密钥）

部署前在仓库中把项目根目录设置为 `jubeat-wiki-v2`，并先执行 `npm ci && npm run build`。两个平台均使用 `npm run build`，发布目录均为 `dist/`。

### Vercel

1. 在 Vercel 新建/导入项目，将 **Root Directory** 设为 `jubeat-wiki-v2`。
2. 保持 `vercel.json` 的构建命令 `npm run build` 与输出目录 `dist`，或在项目设置中使用相同值。
3. 连接仓库后由 Vercel 执行构建并发布；命令行发布仅在已完成登录和项目确认后按平台流程手动执行。

### Cloudflare Pages

1. 在 Cloudflare Pages 创建 Git 项目，将根目录设为 `jubeat-wiki-v2`。
2. 配置构建命令为 `npm run build`、构建输出目录为 `dist`；`wrangler.toml` 同样声明 `pages_build_output_dir = "./dist"`。
3. 可选的手动发布命令为 `npx wrangler pages deploy dist --project-name jubeat-music-cube-wiki-v2`，仅在已登录、已确认目标项目后执行。

本仓库没有令牌、账户 ID、API 密钥或生产环境变量；本文档不会触发部署。更完整的交付边界、路由、数据来源及后续预留见 [`docs/DELIVERY.md`](docs/DELIVERY.md)。
