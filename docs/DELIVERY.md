# jubeat 音乐魔方 WIKI v2 交付说明

**交付类型：** Astro SSG 静态站点  
**构建命令：** `npm run build`  
**发布目录：** `dist/`  
**部署状态：** 本交付仅提供配置与操作步骤；未执行 Vercel/Cloudflare Pages 真实部署，未写入任何密钥。

## 1. 本次范围

本次交付将既有抓取与审计数据集成至 Astro 静态站点：

- 500 首曲目的静态列表、详情页与 `search-index.json`；
- 曲目、jubility、充能池、版本/更新、玩法、段位、指南与关于页面；
- 可离线构建的曲绘与正式 Logo 资源；
- 同时面向 Vercel 和 Cloudflare Pages 的 `npm run build → dist/` 部署配置；
- 无 JavaScript 时仍可阅读主导航与关键正文的渐进增强输出。

不在本次范围内：生产账号配置、域名/DNS、真实部署、运行时 API、密钥管理，以及把数据缺口推断为事实。`functions/` 仅是未来同源 Pages Functions 的预留位置，当前交付没有运行时后端依赖。

## 2. 静态路由与产物

Astro 使用目录式静态 URL（`trailingSlash: 'always'`）。主要入口如下：

| 分类 | 路由 |
| --- | --- |
| 首页 | `/` |
| 曲目库 | `/songs/` |
| 曲目详情 | `/songs/<数字 songId>/`；特殊 `title:` ID 为可逆的 `/songs/id-<Unicode 码点十六进制>/` |
| jubility | `/jubility/` |
| 充能池 | `/unlock/` |
| 版本与更新 | `/versions/`、`/updates/` |
| 玩法、段位、指南、关于 | `/gameplay/`、`/dans/`、`/guide/`、`/about/` |
| 机器可读产物 | `/search-index.json`、`/robots.txt`、`/sitemap-index.xml` |
| 兜底页 | `/404.html` |

部署时应原样托管 `dist/`，不要将单页应用重写规则应用到曲目详情页；这些页面均是预渲染文件。`vercel.json` 的 `cleanUrls` 与 Astro 目录式输出相容，Cloudflare Pages 由 `pages_build_output_dir = "./dist"` 接管静态目录。

## 3. 数据来源、口径与再生成

交付数据为离线快照，来源与 SHA-256 记录在 `data/data-meta.json`：

- `jubeat-wiki/data/songs.json`：S1/S2/S3/S5/S6/S7 聚合历史曲目快照；
- `jubeat-wiki/data/wiki-meta.json`：S3/S6/S7 聚合历史元数据；
- `jubeat-wiki/data/cover-map.json`：S8 曲绘映射；
- `data/_audit/out/summary.json` 与 `gaps-covers.json`：本轮审计结果。

数据再生成脚本是 `scripts/build-data.mjs`，它读取相邻的 `../jubeat-wiki/` 与上述审计文件，重建 `data/*.json` 及 `public/jackets/`，且不联网。再生成前后均应执行：

```sh
npm run verify:data
npm run build
npm run verify:static-final
```

多源冲突不会被静默抹平：权威口径、候选值、差额与处理建议均登记在 `data/data-conflicts.json`。字段缺失保持 `null`，详见 `data/data-meta.json` 的 `missing` 与 `missingRecords`。

## 4. 已知缺口与限制

当前交付明确保留以下数据状态（以 `data/data-meta.json` 为准）：

- 6 首曲目无曲绘；
- 18 首曲目 BPM 缺失；
- 215 首无 remywiki 考据数据；
- 15 首谱面信息不完整；
- 充能池存在 94 个未能映射为独立曲目对象的条目；池总数的 179/185 口径差异与曲库总量等冲突已在 `data/data-conflicts.json` 登记。

浏览器审计也须诚实区分：`docs/static-final-evidence.json` 是本轮 Node 静态产物终验，记录 **72 项通过、0 项失败**；历史 Chrome evidence 已不可恢复，因此没有把浏览器、Lighthouse 或 axe 结果作为本轮通过证据。待浏览器工具链稳定后再重新执行真实审计。

## 5. 构建自检证据

- `docs/static-final-evidence.json`：对 `dist/` 的文件、路由、导航、Logo/主题、来源/冲突语义、unlock 双轨、URL 与无 JS 正文做硬断言，当前 72 passed / 0 failed；
- `docs/acceptance-evidence.json`：搜索索引、sitemap、曲绘资源预算、部署配置与渐进增强验收汇总；其中未执行的浏览器检查标记为 `skipped`，不会伪报通过；
- `docs/platform-build-manifest.json`：构建命令、输出目录、Node 版本与静态文件 SHA-256 清单。

推荐交付前从干净依赖状态运行：

```sh
npm ci
npm run verify:data
npm run build
npm run verify:acceptance
npm run verify:static-final
```

## 6. 平台部署准备（不执行）

| 平台 | 项目根目录 | 构建命令 | 输出目录 | 配置 |
| --- | --- | --- | --- | --- |
| Vercel | `jubeat-wiki-v2` | `npm run build` | `dist` | `vercel.json` |
| Cloudflare Pages | `jubeat-wiki-v2` | `npm run build` | `dist` | `wrangler.toml` |

配置文件不含令牌、账户 ID、项目 ID 或其他密钥。真实部署需由拥有目标平台权限的维护者在平台控制台或其已认证的 CLI 环境中执行；本交付不替代该授权步骤。

## 7. 下一轮预留

1. 在可复现的浏览器环境中补跑首页、曲库、详情和玩法页的 Lighthouse、axe 与 375/768/1440 响应式审计，并以新证据替换 `skipped` 项。
2. 为 6 个无曲绘、18 个 BPM 缺失、215 个考据缺口和 15 个不完整谱面补充可追溯来源；保持 `null` 直到证据到位。
3. 依据 `data/data-conflicts.json` 对曲库总量、充能池口径与 current 难度行做来源复核，不以展示便利为由合并冲突。
4. 若引入收藏、投票等动态能力，在 `functions/` 增加显式 API 契约、认证/限流与隐私设计；静态内容仍保持独立可访问。
5. 在部署账号与域名确定后，将生产域名与缓存策略作为独立变更评审，并重新生成 sitemap 和完整验收证据。
