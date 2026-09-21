# 项目维护笔记

本文件记录 jubeat 音乐魔方 WIKI v2 的架构决策、环境配置与踩过的坑。
面向「几个月后回来接手」的场景：只写重新发现代价高的东西。

---

## 1. 线上资产

| 项 | 值 |
| --- | --- |
| 站点地址 | https://v2.byd-ub.top |
| Vercel 项目 | `snowind/jubeat-wiki-v2` |
| 公开代码仓库 | https://github.com/SnowindMe/jubeat-wiki-v2 |
| **私有数据仓库** | https://github.com/SnowindMe/jubeat-wiki-data |
| 域名 DNS | Cloudflare（`huxley` / `naya.ns.cloudflare.com`） |
| GitHub 账号 | `SnowindMe` |

> ⚠️ **根域名 `www.byd-ub.top` 跑着另一个独立站点**（完整度更高，参考图都来自它）。
> 本项目的重构站只放在 `v2` 子域名，**不要动根域名**。

---

## 2. 架构与数据流

```
push to main
   ↓
Vercel 自动构建
   ↓
npm run build
   ├── prebuild: scripts/fetch-data.mjs   ← 用 DATA_REPO_TOKEN 拉私有数据
   └── astro build                        ← 生成 511 页静态站
   ↓
dist/ → Vercel CDN → v2.byd-ub.top
```

**为什么数据要放私有仓库**：曲目清单、定数、Jubility、充能、考据与 492 张曲绘
属第三方版权资料，主人要求不进公开仓库。但 Vercel 云端构建又需要它们，
于是拆成「公开仓库只放代码 + 私有仓库放数据 + 构建时拉取」。

**DNS 配置要点**：`v2` 的 CNAME 指向 Vercel 给的地址，代理状态必须是
**DNS only（灰云）**。开橙云会让 Cloudflare 与 Vercel 的 SSL 打架，
症状是 `ERR_TOO_MANY_REDIRECTS` 或证书不匹配。

---

## 3. 环境与凭据

| 名称 | 用途 | 位置 |
| --- | --- | --- |
| `DATA_REPO_TOKEN` | 构建时读私有数据仓库 | Vercel 环境变量（Production/Preview/Development 三环境） |
| gh CLI OAuth | 本机 git/gh 操作 | `gh auth status` 查看 |

`DATA_REPO_TOKEN` 应当是**细粒度 PAT**：Repository access 只勾
`SnowindMe/jubeat-wiki-data`，权限只给 **Contents: Read-only**。

> 不要用 `gh auth token` 的 OAuth token 填进 Vercel —— 它带 `repo` 全量授权，
> 等于把主人名下所有仓库的读写权交给构建环境。

**Cloudflare 凭据现状**：wrangler 已用 `1945743455@qq.com` 登录（OAuth）。
权限含 workers / d1 / pages / kv，**R2 未在权限列表中**，但实测
`wrangler r2 bucket list` 可用（已有 bucket `jubeat-dan-assets`）。
DNS 写权限**没有**（只有 `zone (read)`），改 DNS 需要主人在 CF 控制台操作。

---

## 4. 构建与验收

```sh
npm run fetch:data        # 拉取私有数据（无 token 且本地有数据时自动跳过）
npm run build             # prebuild 会自动调用 fetch:data
npm run verify:data       # 数据校验：500 曲目 / 1473 难度键 / 91 Jubility / 492 曲绘
npm run verify:tokens     # 检查 var(--w-*) 引用是否都有定义
npm run verify:acceptance # 交付验收：8 通过 / 3 跳过 / 0 失败
npm run verify:static-final # 静态终验：73 通过 / 0 失败
```

**验收脚本里不可放宽的断言**（改动页面时容易踩到）：

- `无 JS 静态可读性`：构建 HTML 必须直接含曲库正文与详情页「谱面难度」正文。
  动画只能做渐进增强，不能承载内容。
- `unlock 双轨数字`：`/unlock/` 必须同时出现 `179`、`185`、`差额`、
  **`未匹配原始条目清单`**（标题文字，改名会挂）。
- `首页正式 Logo`：首页需有 `brand__logo` 元素，且构建 CSS 需引用
  `/brand/jubeat-logo.svg`。

**浏览器验收仍为 skipped**：Lighthouse / axe / 响应式溢出三项因验收脚本
未接入浏览器而跳过。本机 Chrome 可用 CDP 驱动（见第 6 节），可以真做，
但尚未接进脚本。

---

## 5. 踩过的坑

### 5.1 描摹 logo：VTracer 会把背景也描进去

`vision_trace` 对「白底黑字」的图，**第 1 条路径是整个白色画布**
（字形被挖成洞），后面才是真正的字形。全部填黑 → 渲染成黑底，整个反了。

**解法**：丢掉第 1 条 path，保留后续字形路径，并用 `fill="currentColor"`。

### 5.2 `<img>` 里的 SVG 无法继承页面颜色

`<img src="logo.svg">` 是隔离文档，`currentColor` 只解析到 SVG 自身的
`color`（黑色），**不会**继承宿主页面。所以暗色模式下 logo 还是黑的。

**解法**：改用 **CSS mask** —— SVG 只当遮罩，颜色由 `background-color:
currentColor` 给：

```css
.brand__logo {
  background-color: currentColor;
  -webkit-mask: url('/brand/jubeat-logo.svg') left center / contain no-repeat;
  mask: url('/brand/jubeat-logo.svg') left center / contain no-repeat;
}
```

### 5.3 View Transitions 会重写 `<html>` 属性，主题在跳页后丢失

暗色模式切到别的页面就变回白天 —— 因为 Astro 的 View Transitions 在
swap 时会重置 `<html>` 上的属性，而 `data-theme` 正挂在 `<html>` 上。

**解法**：在 `astro:after-swap` 重新应用主题（此时新 DOM 已换入、尚未绘制）：

```js
document.addEventListener('astro:after-swap', applyTheme);
```

### 5.4 `<details>` 默认是展开的

导航下拉用 `<details>` 实现，**不加 `open` 属性它也是展开的**，导致所有
子菜单同时铺开互相重叠。必须在初始化时 `removeAttribute('open')`。

### 5.5 删除 token 会让样式静默失效

改版时删掉了 `--w-fs-3xl`、`--w-candy-glint`、`--w-fs-2xl` 等 token，
但页面还在引用 —— 浏览器**静默丢弃**这些声明，不报错，只是样式不对。
这是「有些组件很丑」的隐藏原因。

**解法**：`scripts/check-tokens.mjs`（接入 `verify:tokens`）扫描所有
`var(--w-*)` 引用与定义，列出未解析项。

### 5.6 Vercel `--prebuilt` 部署需要手工构造输出目录

本沙箱里 `vercel build` 会因 `spawn cmd.exe ENOENT` 失败（沙箱不允许
Vercel 调 cmd.exe 跑 npm）。绕过办法是手工构造：

```
.vercel/output/static/   ← dist/ 的内容
.vercel/output/config.json
.vercel/output/builds.json  ← 必须清掉里面的 error 字段，否则 --prebuilt 拒绝部署
```

> 现在已有 Git 自动构建，**不再需要**这套手工流程。

### 5.7 git push 会挂在 Credential Manager

`git push` 走 `credential.helper=manager` 时可能弹窗等待导致超时。
绕过：

```powershell
git -c credential.helper= push "https://x-access-token:$(gh auth token)@github.com/SnowindMe/jubeat-wiki-v2.git" main
```

### 5.8 数据仓库的行尾符

数据仓库没有 `.gitattributes` 时，git 会把 CRLF 规范化为 LF，导致
`fetch-data` 拉下来的文件与本地字节不同（JSON 解析结果一致，但哈希不同）。
已加 `.gitattributes`（`* text=auto eol=lf`）固定。

### 5.9 PowerShell 与工具的限制

- 路径含 `[` `]`（如 `songs/[songId].astro`）时必须用 `-LiteralPath`。
- `System.Drawing` **读不了 webp**。
- `Resolve-DnsName` 对 Cloudflare 代理的记录可能返回空行，属正常。
- vision 工具的路径相对**会话工作区**解析，附件目录不在允许范围内，
  需先复制进工作区；且文件扩展名必须与真实格式一致（jpeg 不能叫 .png）。

---

## 6. 真机验证手段（重要）

本机 Chrome 可用于真实渲染验证，比「凭想象」可靠得多：

```powershell
# 启动带调试端口的 headless Chrome
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList "--headless=new","--disable-gpu","--no-sandbox",
                "--remote-debugging-port=9228","--user-data-dir=$env:TEMP\cdp","about:blank"
```

然后用 CDP（Node 22 自带 `fetch` 与 `WebSocket`）驱动：
`Page.navigate` / `Runtime.evaluate` / `Page.captureScreenshot`，
并用 `Emulation.setEmulatedMedia` 强制 `prefers-color-scheme` 来分别验证明暗主题。

**注意**：验证「主题跨页保持」这类 bug 时必须**点击页面内链接**
（触发客户端导航），不能用 `Page.navigate`（那是整页刷新，测不出问题）。

---

## 7. 未完成事项

- [ ] 移动端 header：`导航` 按钮与主题按钮间距偏紧，主题按钮贴边。
- [ ] `/songs/` 3 列卡片在 375px 下的折行未验证。
- [ ] 浏览器验收（Lighthouse / axe / 响应式溢出）仍未接入脚本，长期 skipped。
- [ ] `/jubility/` 表格 91 行较长，可考虑分组或筛选。
- [ ] **用户系统**：已登录用户可编辑词条。
- [ ] **Markdown 富文本支持**：含服务端消毒（XSS 是头号风险）。

### 用户系统的关键决策（尚未拍板）

整站是 Astro SSG 纯静态，且验收有「无 JS 静态可读性」硬断言；
用户可编辑内容本质动态，两者需要调和。三条路线：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A 构建时重生成 | 编辑写 D1 → 触发 Deploy Hook → 整站重建 | 每次编辑等 2–3 分钟，511 页全量重建 |
| B 运行时渲染 | 页面是静态壳，正文客户端从 API 取 | **破坏无 JS 可读性** |
| C 混合（推荐） | 基础数据构建时烘焙，用户贡献单独一层客户端合并并视觉区分 | 两套内容源需合并 |

Markdown 必须：**服务端消毒**（不能只靠客户端）、禁用原始 HTML 或严格白名单、
**存原始 Markdown** 而非渲染后的 HTML。

---

## 8. 设计参考

主人给的参考站，已实际截图查看：

| 站点 | 是什么 | 可借鉴之处 |
| --- | --- | --- |
| `sss-jubeat.pages.dev` | jubeat 難易度表 | 按定数分组的排行行、深色定数块、定数徽章叠在曲绘上、「地力↔手法」光谱轴 |
| `ub.mcu.moe` | 跑步解锁路线图表 | 渐变统计块、每首歌的累计进度、4 列曲目卡 |
| `dynamix.miraheze.org` | MediaWiki Timeless 皮肤 | 左侧分组导航、统计条、**编辑政策 Notice**、页面标签与操作栏 |

曲目卡片最终采用的形态（来自赛事信息图）：**曲绘在左，右侧标题 + artist
+ 两行药丸标签**（难度实心、BPM/机种描边），3 列网格。
