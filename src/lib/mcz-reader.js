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
// 因此本模块严格遵循三条：
//   1) 总长以 `bytes=0-` 全量响应的**真实字节数**为准（geometry()），不用声明值；
//   2) 每一个 Range 窗口起点都以响应头 content-range 里的**实际起点**为准；
//   3) 读取条目时按 local header 的签名自校验，不匹配就在窗口内搜 LFH 签名纠偏。
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

/** 把 jsDelivr 默认前缀替换成当前生效的节点前缀。 */
export function applyCdnBase(url) {
  if (!cdnBase) return url;
  return url.replace(
    /^https:\/\/cdn\.jsdelivr\.net\//,
    cdnBase.endsWith('/') ? cdnBase : cdnBase + '/',
  );
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
    // 1) 首选开放式全量 Range：同时拿到「声明总长」与「真实字节数」。
    //    这是唯一能拿到真实长度的路径，必须重试到拿到为止 ——
    //    若这里因为瞬时断流而静默降级，兜底路径只能拿到虚高的声明长度，
    //    后续算 tailStart 就会整体漂移，正是「未找到 EOCD」的成因。
    try {
      const r = await fetchWithRetry(real, { headers: { Range: 'bytes=0-' } });
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length) {
          const cr = r.headers.get('content-range') || '';
          const declared = Number(cr.match(/bytes\s+\d+-\d+\/(\d+)/)?.[1] || buf.length);
          return { declaredLen: declared, realLen: buf.length, skew: declared - buf.length };
        }
      }
    } catch {
      /* 退回闭区间 + HEAD */
    }

    // 2) 兜底：闭区间探声明总长（顺带预热边缘缓存，代价 1 KB）
    let declared = 0;
    try {
      const r = await fetchWithRetry(real, { headers: { Range: 'bytes=0-1023' } });
      await r.arrayBuffer().catch(() => null);
      const cr = r.headers.get('content-range') || '';
      declared = Number(cr.match(/bytes\s+\d+-\d+\/(\d+)/)?.[1] || 0);
      if (!declared && r.ok) declared = Number(r.headers.get('content-length') || 0);
    } catch {
      /* 继续 */
    }
    if (!declared) {
      try {
        const head = await fetchWithRetry(real, { method: 'HEAD' });
        if (head.ok) declared = Number(head.headers.get('content-length') || 0);
      } catch {
        /* 交给调用方报错 */
      }
    }
    return { declaredLen: declared, realLen: declared, skew: 0 };
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

/**
 * 读取远端 zip 的条目表（中央目录）。
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
      // 只在还有重试机会时清理几何缓存：
      // 这类失败多半是总长探测偏了（瞬时断流导致拿到虚高的声明长度），
      // 清掉缓存让下一轮重新探测真实长度，而不是复用错误结果。
      if (attempt < tries) {
        geoCache.delete(applyCdnBase(url));
        await sleep(backoffMs(attempt));
      }
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
