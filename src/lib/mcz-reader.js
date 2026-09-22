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
 * **幂等**：如果 base 里已经含仓库路径段（例如 raceCdnNodes 返回的 ranked 项的
 * `.node.base` 本身就是补全过的），则原样返回 —— 再追加一次会变成
 * `.../gh/<repo>/<repo>/` 而 404。
 *
 * @param {Array<{id:string, base:string, label?:string}>} nodes
 * @param {string} sampleUrl 任一节点的完整 .mcz URL（用来取仓库路径段）
 */
export function nodesWithBase(nodes, sampleUrl) {
  const repo = repoPathOf(sampleUrl);
  if (!repo) return nodes.map((n) => ({ ...n }));
  return nodes.map((n) => {
    const base = n.base;
    // repoPathOf 返回的 repo 不带前导 /（/gh/ 已被正则吃掉），无需再 strip。
    if (/\/gh\/[^/]+\/[^/]+?\/$/.test(base)) return { ...n };
    return { ...n, base: base.endsWith('/') ? base + repo : base + '/' + repo };
  });
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
      // 只有「整个响应就是整个文件」（200）时 content-length 才等于总长。
      // 206 的 content-length 是**本次区间的长度**（1024），照抄会把 1 KB 当成
      // 整个 .mcz 的总长，随后 readZipEntriesOnce 算出的尾部窗口起点直接为 0，
      // 必然报「不是有效的 zip（未找到 EOCD）」。这种错在 content-range 被 CORS
      // 挡住时特别容易发生，所以只认 200。
      if (!declared && r.status === 200) declared = Number(r.headers.get('content-length') || 0);
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

    // ── 自校正：探测到的总长可能是「虚高」的 ──
    //
    // 为什么必须校：浏览器跨域时 `content-range` 属于非 safelisted 响应头，
    // 节点若没有 `Access-Control-Expose-Headers: content-range`，JS 读到的
    // `r.headers.get('content-range')` 是 null —— 于是上面的 1 KB 探测拿不到
    // 总长，只能退回 HEAD。而 HEAD 走的是**压缩协商**通道：jsDelivr 对 .mcz
    // 会回 `content-encoding: br` 并声明压缩前的 `content-length` = 1805303，
    // 而 Range 通道的真实字节数是 1805295（实测 cdn.jsdelivr.net 与
    // gcore.jsdelivr.net 恒定虚高 8 字节，见 mcz-match.js 节点表注释）。
    //
    // 虚高的后果不是「多读 8 字节」这么轻：readZipEntriesOnce 拿这个总长去算
    // 末尾 64 KB 窗口的起点（totalSize - 65536），起点整体后移 8 字节，由 EOCD
    // 反推出的中央目录偏移就少算 8，CDH 签名匹配不上，于是走「按 EOCD 记录偏移
    // 单独请求」的兜底，读出的条目名/compSize 全错 —— 最终表现为
    // 「不是有效的 zip（未找到 EOCD）」或「条目数据不足（需要 N，收到 0）」。
    //
    // 校法：拿「末尾 64 KB 窗口」当探针，请求 [L-65536, L-1]（L = 探测到的总长）。
    //   · 若 L 虚高，节点会诚实截断到文件尾：
    //       - 带 content-range  → 起点/终点/总长三段全是真值，直接采用；
    //       - 不带（CORS 未暴露）→ body 长度 = 真实总长 - (L-65536)，
    //         即 realLen = (L - 65536) + body.length，同样能反推；
    //   · 若 L 准确，节点会回满 64 KB，body 长度等于请求长度 —— 此时不动，
    //     保持原值即可（虚高量为 0）。
    // 探针窗口与 readZipEntriesOnce 随后要取的窗口完全重合，因此这次探测
    // 顺带把该区段喂进 HTTP 缓存，不额外增加实际传输量。
    if (declared > 8192) {
      // 探针区间故意「恰好越界」：从 declared 稍后一点取一小段。
      //   · declared 准确 → 该区间整体越界，节点回 416（或夹回末尾），
      //     收到 0 字节，判定为「无需校正」；
      //   · declared 虚高 n 字节 → 区间落在文件内，能正常收到声明长度，
      //     且 content-range 的 total 与真实不符 —— 用实收字节数反推。
      // 用短区间（而非早先的 8 KB 窗口）是为了让「实收 vs 请求」的差值
      // 精确等于虚高量，且越界时被掐断的代价最小。
      const probeStart = Math.max(0, declared - 64);
      const probeEnd = declared + 64;
      const want = probeEnd - probeStart + 1;
      // 拆开「取头」与「读体」：越界被掐断时 body 会抛错，但响应头已可用。
      const pr = await fetchWithRetry(real, {
        headers: { Range: `bytes=${probeStart}-${probeEnd}` },
      }).catch(() => null);
      if (pr && (pr.status === 206 || pr.status === 200)) {
        const pm = (pr.headers.get('content-range') || '').match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
        let got = 0;
        try {
          // 必须逐块流式读、不能用 arrayBuffer()：区间越界时节点会先发响应头、
          // 发一部分 body 再掐断连接，arrayBuffer() 一抛错已收到的字节就全丢了；
          // 而这些 partial 字节正是下面反推真实末尾的唯一依据
          //（与 readRange 的处理同理）。
          const reader = pr.body ? pr.body.getReader() : null;
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength) got += value.byteLength;
            }
          } else {
            got = new Uint8Array(await pr.arrayBuffer()).length;
          }
        } catch { /* 掐断：got 保留已收到的 partial，按短给反推 */ }
        try {
          const realEnd = pm ? Number(pm[2]) : NaN;
          const crTotal = pm ? Number(pm[3]) : NaN;
          if (Number.isFinite(realEnd) && Number.isFinite(crTotal) && realEnd + 1 < crTotal) {
            // 节点自报的 total 与它实际给出的 end 自相矛盾 ⇒ end+1 才是真相
            realLen = realEnd + 1;
            declared = realLen;
          } else if (got > 0 && got < want) {
            // body 短给：区间尾部越出了真实文件 ⇒ 真实末尾 = probeStart + got - 1
            realLen = probeStart + got;
            declared = realLen;
          }
        } catch {
          /* 判定本身出错不影响外层 */
        }
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
 * 只重试「可能自愈」的情况：网络异常、5xx、429，以及
 * 「206 Partial Content 但响应体短于请求区间」（边缘节点会返回
 * 206 + content-length: 0 的空响应，属瞬时抖动）。
 * 4xx（除 429）是请求本身有问题，重试没意义，直接抛。
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{tries?:number, onRetry?:(attempt:number, err:Error)=>void}} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, { tries = 2, onRetry } = {}) {
  // ── 强制 identity 编码：这是整套 Range 读取能成立的前提 ──
  //
  // 实测（_lead_enc_probe.mjs，同一 URL、同一 Range，只改 Accept-Encoding）：
  //   A 默认（Node 不带该头）           → content-range: bytes 0-1023/1805295, body 1024, 无编码
  //   B `Accept-Encoding: gzip,deflate,br` → content-range: bytes 0-1023/1805303, body 1020, enc=br
  //   C 只要 `br`                        → 同 B
  //   D `identity`                       → 同 A
  //
  // 也就是说，一旦协商成 brotli，jsDelivr 会同时做两件坏事：
  //   1) `content-range` 的总长改报「压缩前」的 1805303，而 HTTP Range 的语义
  //      是按**原始字节**切片，用这个数算 ZIP 尾部窗口起点会整体后移 8 字节；
  //   2) 返回的 body 只有 1020 字节（请求 1024），且这段字节**不是合法的 br 流**
  //      —— Node 的 brotli 解码器直接报 ERR__ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET，
  //      浏览器里则表现为 body 短于声明，最终解压/校验失败。
  // 更要命的是 Range 的字节偏移在压缩传输下**根本不可定义**：第 N 个字节的
  // 偏移只在未压缩时有意义。所以这里必须显式要求 identity，让 CDN 走原始字节通道。
  //
  // 注意 `Accept-Encoding` 是受 CORS 约束的**非 safelisted 请求头**，浏览器下
  // 直接设它可能触发预检失败。实践上浏览器的 `fetch` 允许脚本设置该头（它会
  // 进 `Access-Control-Request-Headers`），jsDelivr 的 CORS 配置允许它；万一
  // 某个节点拒绝，外层还有整体重试兜底。相比之下「坐标漂移到读不出谱面」的
  // 代价远大于「这一次请求被拒」。
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'identity');
  const realInit = { ...init, headers };

  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(url, realInit);
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
      // 206 但响应体短于请求区间，同样值得重试。
      //
      // 边缘节点抖动时会返回「206 Partial Content + content-length: 0」这种
      // 自相矛盾的响应：状态码声称成功、body 却是空的（或比请求区间短）。
      // 其 body 本应逐字节对应请求的 Range，所以「206 却短给」必然是可自愈的
      // 瞬时故障，不是请求本身有问题。若不在这一层拦下，空 body 会一路漂到
      // readZipEntry 的 `usable.length < entry.compSize` 检查，抛出
      // 「条目数据不足（需要 N，收到 0）」并直接终止整个谱面加载。
      // （注：readZipEntry/readZipEntries 各自还有 tries=3 的整体重试兜底，
      // 但那要重走整个条目定位流程；在这里重试只重发这一个 Range 请求，更省。）
      if (r.status === 206 && await shortBody(r, init)) {
        lastErr = new Error(`响应体不足（206 但 body 短于请求区间，HTTP ${r.status}）`);
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

/**
 * 判断一个 206 响应的 body 是否短于请求的闭区间 Range。
 *
 * 只读响应头判断，**绝不消费 body** —— 这个 Response 还要原样交给调用方，
 * 一旦 `arrayBuffer()` 过就再也读不出来了。
 *
 * 判据（按可靠性排序）：
 *  1. `content-length` 明说长度 < 期望 ⇒ 一定是短给。空的 206 通常是
 *     `content-length: 0`，这也是生产里「收到 0」的直接来源。
 *  2. `content-range` 声明的区间跨度 < 期望 ⇒ 也是短给（有的节点不报 content-length）。
 *  3. 两个头都不可用 ⇒ 无法判断，返回 false（不重试），交给调用方按实际
 *     字节数处理，避免把「head 请求 / 开放式 Range」误判成故障。
 *
 * 注意：绝不因「比期望长」而重试 —— 多给是既有的代理对齐/压缩协商容错，
 * 由调用方截断取用，不是故障。
 *
 * @param {Response} r 已确认 status === 206
 * @param {RequestInit} init 发起请求时的 init（用于解析期望长度）
 * @returns {boolean}
 */
function shortBody(r, init) {
  const want = expectedRangeLength(init);
  if (want == null) return false;

  const cl = r.headers.get('content-length');
  if (cl != null) {
    const got = Number(cl);
    if (Number.isFinite(got)) return got < want;
    // content-length 存在但不是数字 ⇒ 不可用，继续看 content-range
  }

  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
  if (m) return Number(m[2]) - Number(m[1]) + 1 < want;

  return false;
}

/**
 * 从请求 init 的 Range 头解析闭区间的期望字节数。
 * 开放式（`bytes=a-`）与后缀式（`bytes=-n`）拿不到确切预期长度，返回 null。
 * @param {RequestInit} init
 * @returns {number|null}
 */
function expectedRangeLength(init) {
  const range = init?.headers?.Range ?? init?.headers?.range;
  if (typeof range !== 'string') return null;
  const m = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start + 1;
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
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
  // 服务端会把起点向上对齐，必须以响应头为准，否则坐标整体漂移
  const hdrStart = m ? Number(m[1]) : start;
  const hdrEnd = m ? Number(m[2]) : end;
  const hdrTotal = m ? Number(m[3]) : 0;

  let bytes;
  const chunks = [];
  let partialLen = 0;
  try {
    // 流式读取：一边读一边留分片。区间越界时节点会先给响应头、发一部分 body
    // 再掐断连接（arrayBuffer() 直接抛 `terminated` / `Failed to fetch`，
    // 已收到的字节全部丢失）。改成逐块读，掐断时还能拿到 partial。
    const reader = r.body ? r.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) { chunks.push(value); partialLen += value.byteLength; }
      }
    } else {
      const whole = new Uint8Array(await r.arrayBuffer());
      chunks.push(whole);
      partialLen = whole.byteLength;
    }
    bytes = new Uint8Array(partialLen);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  } catch (err) {
    // 走到这里说明 body 被中途掐断：越界请求的典型形态。
    //
    // 关键点：**不能**用响应头里 content-range 的 end 作收窄依据 ——
    // 越界时节点回的是「你请求的那个 end」（实测 cr=bytes 4506-12698/8602，
    // 而真实文件只有 8594 字节），照它重试等于原样再发一次越界请求，永远失败。
    //
    // 唯一可靠的信息是「body 实际收到了多少字节」：本次请求从 hdrStart 起算，
    // 收到了 partialLen 字节 ⇒ 文件在 hdrStart+partialLen 处就结束了
    // ⇒ 真实末尾 = hdrStart+partialLen-1。用它收窄区间重试即可拿到完整窗口。
    if (partialLen > 0) {
      const trueEnd = hdrStart + partialLen - 1;
      if (trueEnd >= hdrStart && trueEnd < hdrEnd) {
        const r2 = await fetchWithRetry(real, { headers: { Range: `bytes=${hdrStart}-${trueEnd}` } });
        if (r2.ok) {
          const b2 = new Uint8Array(await r2.arrayBuffer());
          if (b2.length > 0) return { bytes: b2, start: hdrStart, end: trueEnd };
        }
      }
    }
    throw err;
  }

  return {
    bytes,
    start: hdrStart,
    end: hdrEnd,
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
  // 越界防护：CDN 声明虚高时 totalSize - 1 会落在文件外，请求 [.., totalSize-1]
  // 拿不到声明的那几字节，连接被掐断后浏览器直接抛 `TypeError: Failed to fetch`
  // （无栈帧、难定位）。这里先收窄到「确认存在」的范围，再靠 readRange 的
  // content-range 纠偏把真实起点/终点拉回来。
  const winEnd = totalSize - 1;
  let win = await readRange(url, wantStart, winEnd);
  let tail = win.bytes;
  let tailStart = win.start;

  // 若窗口尾部其实超出了文件（响应头把 end 收窄了），把窗口整体前移，
  // 保证 64 KB 都落在真实文件内 —— 否则 EOCD 搜索区间会短一截。
  const tailEndAbs = win.start + tail.length - 1;
  if (win.start > 0 && tailEndAbs < winEnd) {
    const back = Math.min(win.start, winEnd - tailEndAbs);
    const win2 = await readRange(url, win.start - back, winEnd - back);
    if (win2.bytes.length > tail.length) {
      tail = win2.bytes;
      tailStart = win2.start;
    }
  }

  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error('不是有效的 zip（未找到 EOCD）');

  const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
  const cdSize = dv.getUint32(12, true);
  const cdOffset = dv.getUint32(16, true);
  const expectCount = dv.getUint16(10, true);

  // 1.5) 结构性自检（不依赖任何 CDN 的总长声明）
  // EOCD 里的 cdOffset / cdSize 是【文件内部】的相对关系：中央目录就紧跟在
  // 最后一个条目数据之后、EOCD 之前。于是有恒等式：
  //     cd 的绝对起点 = EOCD 的绝对位置 - cdSize          （尾部相邻关系）
  //     cd 的绝对起点 = tailStart + 窗口内偏移(cdOffset 对应处)
  // 若 CDN 声明的总长虚高（实测 jsDelivr 恒虚高 8），我们据其算出的 tailStart 就会
  // 整体后移，导致 EOCD 落在错误位置、甚至请求越界。这里用上述等式反推真实的
  // tailStart 修正量：只要能从 EOCD 解出位置并算出 cdSize，就能独立定位 CD，
  // 完全不需要相信 content-length / content-range 报的总长。
  // 具体做法：先看「按 cdOffset 定位」是否命中 CDH 签名；不命中则用 EOCD 位置反推。
  const eocdAbsIfCorrect = tailStart + eocd; // 当前 tailStart 假设下 EOCD 的绝对位置
  const cdStartFromEocd = eocdAbsIfCorrect - cdSize; // 由尾部相邻关系推出的 CD 绝对起点
  const cdStartFromOffset = tailStart + cdOffset; // 由 EOCD 记录的 cdOffset 推出的 CD 绝对起点
  let tailSkew = 0; // tailStart 需要前移的量
  if (cdStartFromEocd !== cdStartFromOffset) {
    // 两者不一致 ⇒ 说明我们据以计算 tailStart 的总长是错的。
    // 但注意：cdOffset 也是【相对 CD 起点】的文件内偏移，其本身是可靠的；
    // 真正不一致的根源是 tailStart 偏了 (cdStartFromOffset - cdStartFromEocd)。
    // 只有当「窗口内 cdOffset 处」确实没有 CDH 签名时，才需要修正 tailStart。
    const guessInTail = cdOffset - (cdStartFromOffset - tailStart);
    const cdFromEocdInTail = eocd - cdSize;
    const at = cdFromEocdInTail;
    const isCdhAt = (i) =>
      i >= 0 &&
      i + 46 <= tail.length &&
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x01 &&
      tail[i + 3] === 0x02;
    if (at >= 0 && isCdhAt(at) && !isCdhAt(guessInTail)) {
      // 由 EOCD 尾部相邻关系推出的位置才是对的
      tailSkew = cdStartFromEocd - cdStartFromOffset;
    }
  }
  if (tailSkew !== 0) {
    const newStart = tailStart + tailSkew;
    if (newStart >= 0) {
      try {
        const win3 = await readRange(url, newStart, winEnd);
        if (win3.bytes.length > 0) {
          tail = win3.bytes;
          tailStart = win3.start;
        }
      } catch {
        /* 重新取窗口失败就让后续签名扫描来兜底 */
      }
    }
  }

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
