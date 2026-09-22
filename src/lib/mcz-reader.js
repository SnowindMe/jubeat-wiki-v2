// 远端 .mcz 谱面包读取（浏览器端，零第三方依赖）
//
// .mcz = zip，内含：
//   0/<曲名>_<难度> Lv<等级>.mc   谱面 JSON（压缩后仅几 KB）
//   0/bgm.ogg                    音频（约 2 MB）
//   0/jkt_*.png                  曲绘
//
// 两种读取模式：
//   1) 只取谱面（快）：HTTP Range 读末尾 EOCD + 中央目录 + 目标条目，约 9 KB / 三难度
//   2) 取音频/曲绘（大）：同样用 Range，但目标条目本身就有 MB 级
//
// 解压用浏览器原生 DecompressionStream('deflate-raw')，无需 JSZip 之类依赖。
//
// ─────────────────────────────────────────────────────────────
// 关于 CDN 的字节对齐（这是本文件最容易踩的坑，务必保留说明）
//
// jsDelivr 对 .mcz 走 brotli 内容编码，Range 响应的**声明长度与真实字节数不一致**：
//   实测 AMBERGRIS.mcz
//     · bytes=0-1023          -> content-range 声明总长 2264303，实际文件 2264294（多 9）
//     · bytes=0-63            -> 声明 64 字节，实际只给 60 字节
//     · bytes=1000000-1000063 -> 声明 64 字节，实际 64 字节（恰好对上）
//     · bytes=0-（开放式）     -> 真实 2264294 字节，字节全对
// 中央目录里记录的 localOffset 是**真实文件坐标**，若用声明的虚高总长去算窗口起点，
// 坐标会整体漂移，回读条目时越过真实 EOF，拿到 0 字节，
// 前端表现为「条目数据不足（需要 2076，收到 0）」。
//
// 因此本模块严格遵循四条：
//   1) 总长取自 Range 响应的 content-range 声明值（geometry()），并把它当作**该节点自己的
//      坐标空间长度**使用 —— 每个节点的声明总长就是它自己坐标空间的总长，所以「用它算窗口
//      起点、读尾部 EOCD」在该节点上自洽。实测 jsdelivr（声明 1805303 / 真实 1805295，
//      坐标恒定偏移 -4）用声明值算窗口能正确命中 EOCD，反而用真实总长算窗口会找不到 EOCD。
//      注意：这里以前写的是「以 bytes=0- 全量响应的真实字节数为准」，但实现从来不是那样
//      （会多打一次全量请求），注释已按实现更正。
//   2) 每一个 Range 窗口起点都以响应头 content-range 里的**实际起点**为准；
//   3) 读取条目时按 local header 的签名自校验，不匹配就在窗口内搜 LFH 签名纠偏。
//   4) 中央目录的真正第一道防线是**在尾部 64KB 窗口内反向扫 CDH 签名并校验条目数**；
//      按声明 cdOffset 单独取中央目录只是拿不到 EOCD 时的兜底（在虚高节点上那个绝对
//      偏移是错的，所以扫窗口必须排在前面）。
// ─────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * 远端文件几何信息（真实长度 + CDN 声明偏差）。
 * @typedef {{declaredLen:number, realLen:number, skew:number}} FileGeometry
 */

/** @type {Map<string, Promise<FileGeometry>>} */
const geoCache = new Map();

/** 当前生效的 CDN 节点前缀（多节点回退时覆写） */
let cdnBase = null;

/** 覆写 CDN 前缀（多节点回退用）。传 null 恢复默认。 */
export function setCdnBase(base) {
  if (base === cdnBase) return;
  cdnBase = base;
  geoCache.clear();
}

/** 取当前 CDN 前缀 */
export function getCdnBase() {
  return cdnBase;
}

/**
 * 匹配「CDN 前缀」，即 `https://<节点>/gh/<owner>/<repo>@<branch>/` 整段。
 *
 * 为什么必须连 `/gh/<owner>/<repo>@<branch>/` 一起吃掉：这些节点都是 jsDelivr
 * 的镜像，路径形状固定为 `/<gh|npm|...>/<owner>/<repo>@<ref>/<file>`。早先这个
 * 正则只吃到 host（末尾停在 `/`），于是替换时 `gh/SnowindMe/...` 被原样留下，
 * 再拼上新前缀就变成 `https://<新节点>/gh/gh/SnowindMe/...` —— 双份 `/gh/`，
 * CDN 直接回 404，表现为「多节点实测里所有节点都不可用」。
 *
 * owner/repo 段用非贪婪 + 必须有第二个 `/` 收尾，避免把文件路径也吃进去。
 */
const CDN_PREFIX_RE =
  /^https:\/\/(?:cdn\.jsdelivr\.net|fastly\.jsdelivr\.net|gcore\.jsdelivr\.net|jsdelivr\.b-cdn\.net|cdn\.jsdmirror\.com)\/gh\/[^/]+\/[^/]+?\//;

/**
 * 把 CDN 前缀替换成当前生效的节点前缀。
 *
 * `cdnBase` 必须是**含仓库路径的完整前缀**，形如
 * `https://<节点>/gh/<owner>/<repo>@<branch>/`（即 MCZ_CDN_BASE 那一层，
 * 而不是 MCZ_CDN_NODES[i].base 的 `https://<节点>/gh/`）。
 * 传只到 `/gh/` 的前缀会拼出缺 owner/repo 的地址，同样 404。
 */
export function applyCdnBase(url) {
  if (!cdnBase) return url;
  return url.replace(CDN_PREFIX_RE, cdnBase.endsWith('/') ? cdnBase : cdnBase + '/');
}

// ─────────────── 多 CDN 节点实测选择（行锚点：MCZ_CDN_NODES 在 mcz-match.js） ───────────────
// 文件可能超过 64 KB 行锚点窗口，所以本文件里的行号以 grep 结果为准，不要按分段读取的位置推断。

/**
 * 从「基准 URL」与「目标节点前缀」推出该节点上同一文件的完整 URL。
 *
 * 这里的 `base` 必须是**完整前缀**（含 `/gh/<owner>/<repo>@<branch>/`），
 * 不是 MCZ_CDN_NODES[i].base 那种只到 `/gh/` 的形态。为免调用方传错，
 * 下面 `nodesWithBase()` 会从样本 URL 里直接抽出仓库路径段补全。
 *
 * @param {string} url 任一 jsDelivr 系节点的完整 URL
 * @param {string} base 目标完整前缀
 */
export function swapCdnHost(url, base) {
  return url.replace(CDN_PREFIX_RE, base.endsWith('/') ? base : base + '/');
}

/**
 * 从完整 URL 里抽出 `/gh/<owner>/<repo>@<branch>/` 这段里的 **`<owner>/<repo>@<branch>/`**
 * （即去掉开头的 `/gh/`，因为节点的 base 本身就以 `/gh/` 结尾）。
 */
function repoPathOf(url) {
  const m = url.match(/\/gh\/([^/]+\/[^/]+?\/)/);
  return m ? m[1] : null;
}

/**
 * 把「只到 /gh/ 的节点前缀」补全成「含仓库路径的完整前缀」。
 *
 * 为什么要补：MCZ_CDN_NODES[i].base 是 `https://<节点>/gh/`，而
 * setCdnBase / swapCdnHost 要的是含 `<owner>/<repo>@<branch>/` 的完整前缀。
 * 少了这一段就会拼出 404 的地址（见 CDN_PREFIX_RE 的说明）。
 *
 * @param {Array<{id:string, base:string, label?:string}>} nodes
 * @param {string} sampleUrl 任一节点的完整 .mcz URL（用来取仓库路径段）
 */
export function nodesWithBase(nodes, sampleUrl) {
  const repo = repoPathOf(sampleUrl);
  if (!repo) return nodes.map((n) => ({ ...n }));
  return nodes.map((n) => ({
    ...n,
    base: n.base.endsWith('/') ? n.base + repo.replace(/^\//, '') : n.base + repo,
  }));
}

/**
 * 实测一个节点。样本**刻意用真实读取同款的小窗口**，而不是开放式全量请求：
 *   · 五个节点并发探测时不会把下行带宽挤爆（早先用 bytes=0- 全量样本，
 *     1.8MB × 5 并发在弱网下直接把后续的谱面请求拖成 Failed to fetch）；
 *   · 小窗口同样能暴露 brotli 重编码 —— 重编码节点会声明 1024 而实收 1020，
 *     一次请求即可判定。
 *
 * **必须容忍冷文件 404**：CDN 对未被请求过的文件可能先回 404（回源未完成），
 * 稍后重试即 206。实测出现过「五个并发里四个 404、一个 206」的情况，
 * 所以这里对 404 做一次短退避重试，重试仍 404 才判不可用。
 *
 * 判定分三档：
 *   ok=false       重试后仍失败 / 404 / 超时 —— 该节点对这个文件不可用
 *   accurate=false 声明长度与实收字节不符 —— 会触发 ZIP 坐标漂移，降权
 *   accurate=true  既能用又字节精确 —— 优先
 *
 * @param {string} url 任一 jsDelivr 系节点的完整 URL（会被换到目标节点）
 * @param {{id:string, base:string}} node
 * @param {{timeoutMs?:number, sampleRange?:string}} [opts]
 */
export async function benchCdnNode(url, node, { timeoutMs = 6000, sampleRange = 'bytes=0-1023' } = {}) {
  const target = swapCdnHost(url, node.base);
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;

  const once = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, { headers: { Range: sampleRange }, signal: ctrl.signal });
      if (res.status === 404) return { retry: true, status: 404 };
      if (!res.ok && res.status !== 206) return { fatal: 'status ' + res.status };
      const cr = res.headers.get('content-range');
      let declaredTotal = null;
      if (cr) {
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
        if (m && m[3] !== '*') declaredTotal = Number(m[3]);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      let want = null;
      const rm = /bytes=(\d+)-(\d+)/.exec(sampleRange);
      if (rm) want = Number(rm[2]) - Number(rm[1]) + 1;
      const realLen = buf.byteLength;
      const magicOk = realLen >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
      const exact = want == null ? true : realLen === want;
      return { done: true, declaredTotal, realLen, want, magicOk, exact, status: res.status };
    } catch (e) {
      return { fatal: String(e?.name === 'AbortError' ? 'timeout' : e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let r = await once();
    // 冷文件 404：短退避后重试一次
    if (r.retry) {
      await new Promise((res) => setTimeout(res, 400));
      r = await once();
    }
    if (r.done) {
      return {
        id: node.id,
        ok: true,
        accurate: r.exact && r.magicOk,
        magicOk: r.magicOk,
        ttfb: elapsed(),
        dur: elapsed(),
        declaredTotal: r.declaredTotal,
        realLen: r.realLen,
        want: r.want,
        reason: r.exact ? (r.magicOk ? '' : '字节数对但不是 ZIP') : `重编码（期望 ${r.want} 实收 ${r.realLen}）`,
      };
    }
    if (r.retry) {
      return { id: node.id, ok: false, accurate: false, ttfb: elapsed(), dur: 0, declaredTotal: null, realLen: 0, reason: '404 重试后仍不可用' };
    }
    return { id: node.id, ok: false, accurate: false, ttfb: elapsed(), dur: 0, declaredTotal: null, realLen: 0, reason: r.fatal };
  } catch (e) {
    return { id: node.id, ok: false, accurate: false, ttfb: elapsed(), dur: 0, declaredTotal: null, realLen: 0, reason: String(e?.message || e) };
  }
}

/**
 * 串行实测所有节点并排序，返回最优节点。
 *
 * **必须串行探测**：CDN 对「同一文件、同一小 Range、多路并发」这种形态会限流
 * （实测五个 `bytes=0-1023` 并发里四个回 404，而同一时刻偏移量大的窗口全是 206）。
 * 串行探测即可避开；实测同一节点连续 12 次串行 `bytes=0-1023` 全部 206，
 * 所以这里**统一用 `bytes=0-1023` 这一个窗口**，不额外错开偏移 —— 错开偏移既没有
 * 实测依据，也会让各节点的判定基准不可比（声明长度只在同一窗口下才可比）。
 *
 * 排序规则（与 _cdn_bench_browser.mjs 的实测结论一致）：
 *   1) 可用的排在不可用之前；
 *   2) 可用的里面，字节精确的排在会被 brotli 重编码的之前
 *      —— 快但坐标漂移的节点会稳定地读坏谱面，不能只看速度；
 *   3) 同档内按 TTFB 升序。
 *
 * 节点表的 base 允许是只到 `/gh/` 的形态；这里会用 sampleUrl 里的仓库路径段
 * 补全成完整前缀再探测，返回的 ranked[].node.base 已是完整前缀，可直接交给
 * setCdnRanking（否则 setCdnBase 会拼出 404 的地址）。
 *
 * @param {string} sampleUrl 任一 jsDelivr 系节点的 .mcz URL
 * @param {Array<{id:string, base:string}>} nodes
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{best:object|null, ranked:Array}>}
 */
export async function raceCdnNodes(sampleUrl, nodes, opts = {}) {
  const full = nodesWithBase(nodes, sampleUrl);
  const results = [];
  for (let i = 0; i < full.length; i++) {
    const n = full[i];
    // 统一窗口：串行探测不会触发限流，同一窗口也让各节点字节精确性可比
    const r = await benchCdnNode(sampleUrl, n, { ...opts, sampleRange: 'bytes=0-1023' });
    results.push({ ...r, node: n });
  }
  const ranked = results.slice().sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.accurate !== b.accurate) return a.accurate ? -1 : 1;
    return a.ttfb - b.ttfb;
  });
  const best = ranked.find((r) => r.ok && r.accurate) || ranked.find((r) => r.ok) || null;
  return { best, ranked };
}

/**
 * 探测远端文件几何信息（同一 URL 并发调用共享一次探测）。
 * @param {string} url
 * @returns {Promise<FileGeometry>}
 */
async function geometry(url) {
  const real = applyCdnBase(url);
  if (geoCache.has(real)) return geoCache.get(real);

  const p = (async () => {
    // 只要 1 KB 就能拿到文件总长：206 响应头里的 content-range 是
    //   bytes 0-1023/1934866      ← 末尾就是真实总长
    // 早先这里首选的是开放式 `bytes=0-`，那等于把整个 .mcz 全量下载一遍
    // （实测 1.9 MB）只为了拿一个数字，之后再重新 Range 请求中央目录与条目，
    // 白白多传一倍数据、多花好几秒。闭区间探测同样能拿到总长，且带缓存预热。
    let declared = 0;
    let realLen = 0;
    try {
      const r = await fetchWithRetry(real, { headers: { Range: 'bytes=0-1023' } });
      const buf = new Uint8Array(await r.arrayBuffer());
      const cr = r.headers.get('content-range') || '';
      declared = Number(cr.match(/bytes\s+\d+-\d+\/(\d+)/)?.[1] || 0);
      if (!declared && r.ok) declared = Number(r.headers.get('content-length') || 0);
      // 没拿到 content-range 时只能退回「响应体长度」，但那只覆盖 1 KB，
      // 不能当作总长，所以这种情况交给下面的 HEAD 兜底。
      if (declared) realLen = declared;
      void buf;
    } catch {
      /* 交给下面的 HEAD 兜底 */
    }
    if (!declared) {
      try {
        const head = await fetchWithRetry(real, { method: 'HEAD' });
        if (head.ok) declared = Number(head.headers.get('content-length') || 0);
      } catch {
        /* 交给调用方报错 */
      }
    }
    return { declaredLen: declared, realLen: realLen || declared, skew: 0 };
  })();

  geoCache.set(real, p);
  try {
    return await p;
  } catch (e) {
    geoCache.delete(real);
    throw e;
  }
}

/**
 * 带指数退避的 fetch 重试包装。
 *
 * 为什么需要：实测这套 Range 读取偶发「未找到 EOCD」/ 字节数不足的瞬时失败，
 * 连跑多轮无法稳定复现，CDN 直探（_probe_geo.mjs）8 轮又完全稳定 ——
 * 说明它不是确定性 bug，而是边缘节点的瞬时抖动（连接被切断、缓存回源失败）。
 * 对这类失败，重试比究根因更划算。
 *
 * 层次：底层 fetch 重试 × 上层 readZipEntries/readZipEntry 整体重试。
 * 为避免请求数叠乘爆炸，底层只重试 2 次（最坏 2×3=6 次/调用）。
 *
 * 只重试「可能自愈」的情况：网络异常、5xx、429。
 * 4xx（除 429）是请求本身有问题，重试没意义，直接抛。
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{tries?:number, onRetry?:(attempt:number, err:Error)=>void}} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, { tries = 2, onRetry } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(url, init);
      // 5xx / 429 值得重试；其余状态码交给调用方判断
      if (r.status >= 500 || r.status === 429) {
        lastErr = new Error('读取失败 HTTP ' + r.status);
        if (attempt < tries) {
          if (onRetry) onRetry(attempt, lastErr);
          await sleep(backoffMs(attempt));
          continue;
        }
        return r;
      }
      return r;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < tries) {
        if (onRetry) onRetry(attempt, lastErr);
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error('网络请求失败');
}

/** 退避时长：300ms、900ms、2700ms（带少量抖动，避免同时重试挤在一起） */
function backoffMs(attempt) {
  const base = 300 * 3 ** (attempt - 1);
  return base + Math.random() * 120;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取远端文件真实总长度（已校准 brotli 声明偏差）。
 * @param {string} url
 * @returns {Promise<number>}
 */
export async function contentLength(url) {
  return (await geometry(url)).realLen;
}

/**
 * 取远端文件几何信息（真实长度 + 声明偏差）。
 * @param {string} url
 * @returns {Promise<FileGeometry>}
 */
export async function fileGeometry(url) {
  const g = await geometry(url);
  if (typeof globalThis.__jpGeoLog === 'function') globalThis.__jpGeoLog(applyCdnBase(url), g);
  return g;
}

/**
 * 发一次闭区间 Range 请求，返回字节与响应头里的**实际起点**。
 *
 * CORS 的 safelisted Range 只接受单个闭区间 `bytes=N-M`；后缀式 `bytes=-N`
 * 在 Chrome 里会触发预检而 jsDelivr 预检不带 Allow-Headers: range，
 * 表现为 `Failed to fetch`。所以除全量探测外一律用闭区间。
 *
 * @param {string} url
 * @param {number} start
 * @param {number} end
 * @returns {Promise<{bytes:Uint8Array, start:number, end:number}>}
 */
async function readRange(url, start, end) {
  const real = applyCdnBase(url);
  const r = await fetchWithRetry(real, { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
  // 服务端会把起点向上对齐，必须以响应头为准，否则坐标整体漂移
  return {
    bytes,
    start: m ? Number(m[1]) : start,
    end: m ? Number(m[2]) : end,
  };
}

/** 在窗口里找 EOCD 签名（从后往前） */
function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/** 在窗口里找 local file header 签名（从前往后，用于坐标纠偏） */
function findLfh(buf, limit = 64) {
  const max = Math.min(limit, buf.length - 4);
  for (let i = 0; i <= max; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      return i;
    }
  }
  return -1;
}

/** 排序后的节点名单（由 setCdnRanking 写入，读取失败时按它换节点） */
let cdnRanking = null;
/** 当前用第几个节点（越靠前越优） */
let cdnRankIndex = 0;

/**
 * 登记节点回退名单，**不发任何请求**。
 *
 * 会把首选节点设为当前生效前缀 —— 这一点是必须的：页面里那些 .mcz 地址是
 * **构建期**烧进 HTML 的（取自当时的 MCZ_CDN_BASE），运行期改 mcz-match.js
 * 的常量不会追改已生成的索引。要让「换默认源」真的生效，只能在这里用
 * setCdnBase 把读取时的前缀替换掉。
 *
 * 入参允许两种形状，都会归一成「含仓库路径的完整前缀」再生效：
 *   · raceCdnNodes 的 ranked 项（节点在 `.node.base` 上，且可能是只到 /gh/ 的形态）
 *   · 直接给 `{id, base}` 的节点表
 * 归一很关键：早先直接取 `ranked[0].base`，而 raceCdnNodes 返回的项根本没有顶层
 * `base`（它在 .node 里），于是 cdnBase 被设成 undefined、applyCdnBase 原样返回，
 * 整条多节点回退静默失效。
 *
 * @param {Array<{id:string, base?:string, node?:{id:string, base:string}}>} ranked 已排好序的节点列表
 * @param {string} [sampleUrl] 用来补全仓库路径段的样本 URL；缺省时若 base 已是完整前缀则直接可用
 */
export function setCdnRanking(ranked, sampleUrl) {
  const list = (ranked || [])
    .map((r) => (r && r.node ? { ...r.node } : { ...r }))
    .filter((n) => n && typeof n.base === 'string' && n.base.length > 0);
  const normalized = list.length && sampleUrl ? nodesWithBase(list, sampleUrl) : list;
  cdnRanking = normalized.length ? normalized : null;
  cdnRankIndex = 0;
  if (cdnRanking) setCdnBase(cdnRanking[0].base);
}

/** 当前生效节点在排序里的下标（调试用） */
export function getCdnRankIndex() {
  return cdnRankIndex;
}

/**
 * 换到下一个节点。返回是否换成功。
 * **只在读取已经彻底失败后才调用** —— 早先版本每次失败都换，配合重试
 * 会在几秒内对同一个文件反复打 `bytes=0-1023`，把 CDN 的限流窗口一直续着，
 * 反而让本来能成功的读取也被 404 拖死。
 */
export function advanceCdnNode() {
  if (!cdnRanking || cdnRankIndex + 1 >= cdnRanking.length) return false;
  cdnRankIndex += 1;
  setCdnBase(cdnRanking[cdnRankIndex].base);
  return true;
}

/**
 * 读取远端 zip 的条目表（中央目录）。
 *
 * 重试策略刻意保守，因为**重试本身会加重 CDN 限流**：实测同一个节点、
 * 同一个 `bytes=0-1023`，前一次 206、几毫秒后 404 —— CDN 对短时高频的
 * 小窗口访问会限流。早先版本在这里「每次失败都换节点 + 立刻重试」，
 * 结果每轮都再打一次 `bytes=0-1023`，反而把限流一直续着，最后连
 * 一次成功的读取都被后面的 404 埋葬。
 *
 * 所以：失败后退避更久，且**只有三轮都失败才换节点**。
 *
 * @param {string} url
 * @returns {Promise<Array<{name:string,compMethod:number,compSize:number,uncompSize:number,localOffset:number}>>}
 */
export async function readZipEntries(url, opts = {}) {
  const tries = opts.tries ?? 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await readZipEntriesOnce(url);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < tries) {
        // 这类失败多半是总长探测偏了（瞬时断流导致拿到虚高的声明长度），
        // 清掉缓存让下一轮重新探测真实长度，而不是复用错误结果。
        geoCache.delete(applyCdnBase(url));
        // 让 CDN 的限流窗口过去：退避比上一版长得多
        await sleep(backoffMs(attempt) * 4);
      }
    }
  }
  // 三轮都没成就说明这个节点确实不行，换下一个节点再给最后一次机会。
  if (advanceCdnNode()) {
    geoCache.delete(applyCdnBase(url));
    await sleep(600);
    try {
      return await readZipEntriesOnce(url);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error('读取谱面包失败');
}

/**
 * 单次尝试：读取远端 zip 的条目表（中央目录）。
 * @param {string} url
 * @returns {Promise<Array<{name:string,compMethod:number,compSize:number,uncompSize:number,localOffset:number}>>}
 */
async function readZipEntriesOnce(url) {
  const totalSize = await contentLength(url);
  if (!totalSize) throw new Error('无法取得文件长度（缺少 Content-Length）');

  // 1) 取末尾 64 KB 找 EOCD
  const tailLen = Math.min(65536, totalSize);
  const wantStart = totalSize - tailLen;
  const win = await readRange(url, wantStart, totalSize - 1);
  const tail = win.bytes;
  const tailStart = win.start;

  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error('不是有效的 zip（未找到 EOCD）');

  const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
  const cdSize = dv.getUint32(12, true);
  const cdOffset = dv.getUint32(16, true);
  const expectCount = dv.getUint16(10, true);

  // 2) 定位中央目录：直接扫描 CDH 签名并验证条目数能对上，
  //    这是对 CDN 坐标漂移最不敏感的做法（窗口仅 64 KB，扫描成本可忽略）
  let cdStartInTail = -1;
  for (let i = Math.min(tail.length - 22 - cdSize, tail.length - 46); i >= 0; i--) {
    if (
      tail[i] !== 0x50 ||
      tail[i + 1] !== 0x4b ||
      tail[i + 2] !== 0x01 ||
      tail[i + 3] !== 0x02 ||
      i + cdSize > tail.length
    ) {
      continue;
    }
    if (countCentralEntries(tail, i, cdSize) === expectCount) {
      cdStartInTail = i;
      break;
    }
  }

  let cd;
  if (cdStartInTail >= 0) {
    cd = tail.subarray(cdStartInTail, cdStartInTail + cdSize);
  } else {
    // 兜底：窗口内没扫到，按 EOCD 记录的目录偏移单独请求
    const win2 = await readRange(url, cdOffset, cdOffset + cdSize - 1);
    cd = win2.bytes;
  }

  if (cd.length < 46 || new DataView(cd.buffer, cd.byteOffset).getUint32(0, true) !== CDH_SIG) {
    throw new Error(
      `中央目录定位失败（窗口起点 ${tailStart}，目录偏移 ${cdOffset}，长度 ${cdSize}）`,
    );
  }

  // 3) 解析条目
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let off = 0;
  while (off + 46 <= cd.length && cdv.getUint32(off, true) === CDH_SIG) {
    const compMethod = cdv.getUint16(off + 10, true);
    const compSize = cdv.getUint32(off + 20, true);
    const uncompSize = cdv.getUint32(off + 24, true);
    const nameLen = cdv.getUint16(off + 28, true);
    const extraLen = cdv.getUint16(off + 30, true);
    const commentLen = cdv.getUint16(off + 32, true);
    const localOffset = cdv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(cd.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, compMethod, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 从窗口 start 处开始，统计能连续解析出多少个中央目录条目 */
function countCentralEntries(tail, start, cdSize) {
  const end = Math.min(start + cdSize, tail.length);
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let off = start;
  let n = 0;
  while (off + 46 <= end && v.getUint32(off, true) === CDH_SIG) {
    const nameLen = v.getUint16(off + 28, true);
    const extraLen = v.getUint16(off + 30, true);
    const commentLen = v.getUint16(off + 32, true);
    off += 46 + nameLen + extraLen + commentLen;
    n++;
  }
  return n;
}

/**
 * 取单个条目的原始字节（已解压，compMethod=0 则原样返回），失败自动重试。
 *
 * @param {string} url
 * @param {{compMethod:number,compSize:number,localOffset:number,uncompSize?:number}} entry
 * @param {{tries?:number}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(url, entry, opts = {}) {
  // 解压失败（数据被截断）也值得重试：大条目（约 2 MB 的 ogg）在弱网下更易被截断。
  // 注意：只有「压缩方式不支持」这类确定性错误才不该重试。
  const tries = opts.tries ?? 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await readZipEntryOnce(url, entry);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (/不支持的压缩方式|DecompressionStream/.test(lastErr.message)) throw lastErr;
      if (attempt < tries) {
        geoCache.delete(applyCdnBase(url));
        await sleep(backoffMs(attempt));
      }
    }
  }
  throw lastErr ?? new Error('读取条目失败');
}

/**
 * 单次尝试：取单个条目的原始字节（已解压，compMethod=0 则原样返回）。
 *
 * 坐标纠偏：中央目录的 localOffset 是真实文件坐标，但 CDN 的声明坐标可能整体
 * 偏移 skew 字节。这里先按 localOffset 读一段，签名不对就在窗口内搜索 LFH 签名
 * 并用「偏移到签名的距离」重新校正数据起点，避免因 CDN 对齐而整条失败。
 *
 * @param {string} url
 * @param {{compMethod:number,compSize:number,localOffset:number,uncompSize?:number}} entry
 * @returns {Promise<Uint8Array>}
 */
async function readZipEntryOnce(url, entry) {
  const totalSize = await contentLength(url);
  // 多读 8 字节余量：CDN 的 br 响应可能比声明少给几字节，末尾条目尤甚
  const slack = Math.min(8, Math.max(0, totalSize - (entry.localOffset + 30 + entry.compSize)));
  const lhStart = entry.localOffset;
  const lhWin = await readRange(url, lhStart, lhStart + 63);
  let lhBytes = lhWin.bytes;

  let lhOffsetInWindow = 0;
  if (lhBytes.length < 4 || new DataView(lhBytes.buffer, lhBytes.byteOffset).getUint32(0, true) !== LFH_SIG) {
    // 窗口偏移后签名不匹配：在窗口内找 LFH 签名纠偏
    const at = findLfh(lhBytes, 64);
    if (at < 0) {
      throw new Error('local header 签名不匹配（坐标偏移，未找到 LFH）');
    }
    lhOffsetInWindow = at;
  }
  if (lhBytes.length - lhOffsetInWindow < 30) {
    throw new Error(`local header 数据不足（收到 ${lhBytes.length} 字节）`);
  }

  const lh = new DataView(
    lhBytes.buffer,
    lhBytes.byteOffset + lhOffsetInWindow,
    lhBytes.length - lhOffsetInWindow,
  );
  const nameLen = lh.getUint16(26, true);
  const extraLen = lh.getUint16(28, true);
  const dataStart = lhStart + lhOffsetInWindow + 30 + nameLen + extraLen;

  const r1 = await readRange(url, dataStart, dataStart + entry.compSize - 1 + slack);
  const raw = r1.bytes;

  // 服务端可能少给/多给（代理对齐、压缩协商）。只按声明长度取用有效部分。
  const usable = raw.length > entry.compSize ? raw.subarray(0, entry.compSize) : raw;
  if (usable.length < entry.compSize) {
    throw new Error(`条目数据不足（需要 ${entry.compSize}，收到 ${usable.length}）`);
  }

  if (entry.compMethod === 0) return usable;
  if (entry.compMethod === 8) return inflateRaw(usable);
  throw new Error('不支持的压缩方式 ' + entry.compMethod);
}

/**
 * deflate-raw 解压（浏览器原生）。
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 DecompressionStream，无法解压谱面');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 取文本条目 */
export async function readZipText(url, entry) {
  return new TextDecoder().decode(await readZipEntry(url, entry));
}

/**
 * 从条目名推断难度（"AMBERGRIS_EXT Lv9.7.mc" -> "EXT"）。
 *
 * BAS 与 BSC 同义：jubeat plus 系列的谱包把基础难度写成 BAS
 * （如 `bass 2 bass_BAS Lv5.mc`），若只认 BSC 会整档丢失、只解出 2 个难度。
 * 参考实现 jubeatnet 的 DIFF_ORDER 同样把 "BSC" 和 "BAS" 并列。
 */
export function diffOfEntry(name) {
  const m = name.match(/_(BSC|BAS|ADV|EXT)[^/]*\.mc$/i);
  if (!m) return null;
  const key = m[1].toUpperCase();
  return key === 'BAS' ? 'BSC' : key;
}

/**
 * 读取一个 .mcz 的全部信息。
 * @param {string} url
 * @param {{includeAudio?:boolean, includeCover?:boolean}} opts
 */
export async function readMcz(url, { includeAudio = false, includeCover = false } = {}) {
  const entries = await readZipEntries(url);
  const charts = {};
  let audio = null;
  let cover = null;

  for (const e of entries) {
    if (e.name.endsWith('.mc')) {
      const diff = diffOfEntry(e.name);
      if (!diff) continue;
      charts[diff] = { name: e.name, text: await readZipText(url, e) };
    } else if (includeAudio && /\.(ogg|mp3|m4a)$/i.test(e.name)) {
      audio = { name: e.name, bytes: await readZipEntry(url, e) };
    } else if (includeCover && /\.(png|jpg|jpeg)$/i.test(e.name)) {
      cover = { name: e.name, bytes: await readZipEntry(url, e) };
    }
  }
  return { entries, charts, audio, cover };
}
