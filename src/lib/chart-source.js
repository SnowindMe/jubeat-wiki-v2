// 谱面数据源（浏览器端运行时）
//
// 设计：详情页不预下载任何谱面文件；用户点「▶ 预览」时，才按 songId 从 CDN 取 .mcz，
//       用 HTTP Range 只读需要的条目（中央目录 + 三难度 .mc ≈ 9 KB），按需再取音频/曲绘。
//
// 三层：
//   1) loadMczIndex()      —— 拉 data/mcz/index.json（songId -> CDN url）
//   2) fetchChartSet()     —— Range 读 .mcz，解出三难度谱面（Malody .mc -> 结构化音符）
//   3) fetchAssets()       —— 按需取 bgm.ogg / jkt_*.png，转成可用的 blob URL
//
// 依赖：mcz-reader.js（zip + DecompressionStream）、mc-parser.js（.mc 解析）

import { readZipEntries, readZipEntry, readZipText, diffOfEntry } from './mcz-reader.js';
import { parseMc, beatToSeconds } from './mc-parser.js';

const INDEX_URL = '/data/mcz/index.json';
/** 三难度 .mc 很小（合计约 9 KB），一次读完的条目数量上限 */
const CHART_DIFFS = ['BSC', 'ADV', 'EXT'];

let indexPromise = null;

/** 拉取并缓存 mcz 索引（songId -> {url, file, dir, size}） */
export function loadMczIndex() {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return indexPromise;
}

/** 按 songId 取 mcz 元信息，无则 null */
export async function mczForSong(songId) {
  const index = await loadMczIndex();
  return index[String(songId)] || null;
}

/**
 * 把 Malody .mc 文本转成播放器要的结构。
 * @returns {{taps:Array<{key:number,t:number}>, holds:Array<{key:number,endKey:number,t:number,endT:number,beats:number}>, stats:object, bpm:number|null}}
 */
function toPlayable(mcText, fallbackBpm) {
  const parsed = parseMc(mcText);
  const bpms = parsed?.bpms ?? [];
  const notes = parsed?.notes ?? [];
  const holdsRaw = parsed?.holds ?? [];

  // .mc 的 index/endindex 是 0-based（实测取值 0..15），
  // 而渲染端按 1..16 的 data-key 取面板格，所以这里统一 +1 归一到 1..16。
  //
  // hold 是滑动音符（pad 模式）：手指从起点格滑到终点格。
  // 实测天空の華三难度 146 个 hold 全部 key !== endKey —— 跨键是常态而非例外；
  // .mc 只有 beat/index/endbeat/endindex 四个字段，没有中途插值路径，
  // 所以轨迹就是起点格 -> 终点格的直线插值。
  const taps = notes.map((n) => ({ key: n.key + 1, t: round4(beatToSeconds(bpms, n.beat)) }));
  const holds = holdsRaw.map((h) => ({
    key: h.key + 1,
    endKey: h.endKey != null ? h.endKey + 1 : h.key + 1,
    t: round4(beatToSeconds(bpms, h.startBeat)),
    endT: round4(beatToSeconds(bpms, h.endBeat)),
    // 拍长供渲染端分配滑动时长（实测差异极大：0.5 ~ 12 拍）
    beats: round4(h.endBeat - h.startBeat),
  }));

  return {
    taps,
    holds,
    bpm: bpms.length ? bpms[0].bpm : fallbackBpm ?? null,
    stats: {
      noteCount: parsed?.stats?.noteCount ?? taps.length + holds.length,
      holdCount: holds.length,
      tapCount: taps.length,
    },
  };
}

const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0);

/**
 * Range 读取一首歌的 .mcz，解出三难度谱面。
 * 只读中央目录 + 三难度 .mc 条目，不碰音频/曲绘（大幅省流量）。
 *
 * @param {string} url   .mcz 的 CDN 地址
 * @param {{bpm?:number}} opts
 * @returns {Promise<{charts:Record<string,object>, entryNames:string[]}>}
 */
export async function fetchChartSet(url, { bpm } = {}) {
  const entries = await readZipEntries(url);

  // 只挑 .mc 条目，且只挑三难度
  const targets = [];
  for (const e of entries) {
    if (!e.name.endsWith('.mc')) continue;
    const diff = diffOfEntry(e.name);
    if (!diff || !CHART_DIFFS.includes(diff)) continue;
    targets.push({ entry: e, diff });
  }

  const charts = {};
  for (const { entry, diff } of targets) {
    const text = await readZipText(url, entry);
    charts[diff] = {
      ...toPlayable(text, bpm),
      difficulty: diff,
      level: levelOfEntryName(entry.name),
      mczEntry: entry.name,
    };
  }

  return { charts, entryNames: entries.map((e) => e.name) };
}

/** 难度键归一化：接受 bsc/BSC/Bsc 等写法，统一成大写 */
export function normDiff(value) {
  const s = String(value ?? '').trim().toUpperCase();
  return CHART_DIFFS.includes(s) ? s : null;
}

/** 从条目名取等级（"XXX_EXT Lv9.7.mc" -> "9.7"） */
function levelOfEntryName(name) {
  const m = name.match(/Lv\s*([0-9.]+)/i);
  return m ? m[1] : null;
}

/**
 * 音频字节缓存：key = .mcz 的 CDN 地址，value = 该谱包的音频字节 + mime。
 *
 * 为什么必须有：页面上每个难度是**独立的预览器容器**（.jp，data-diff 不同），
 * 三难度各调一次 fetchAssets —— 没有缓存的话同一首歌的 bgm.ogg 会被下载三遍。
 * 实测单个 .mcz 的音频约 1.9 MB（占整包 95% 以上），三难度就是 5.7 MB，
 * 而这正是「明明走了 CDN 还是很慢」的主因。
 *
 * 只缓存字节，不缓存 blob URL：blob URL 的生命周期由调用方 revokeObjectURL 管理，
 * 跨预览器共享同一个 URL 会让释放时机变得难以推理。
 * @type {Map<string, Promise<{bytes:Uint8Array, mime:string, name:string}>>}
 */
const audioCache = new Map();

/** 清空音频缓存（多 CDN 节点切换后旧字节可能不再适用） */
export function clearAudioCache() {
  audioCache.clear();
}

/** 取（并缓存）音频字节；同一 .mcz 并发调用只会真正下载一次 */
export function loadAudioBytes(url) {
  if (audioCache.has(url)) return audioCache.get(url);
  const p = (async () => {
    const entries = await readZipEntries(url);
    const e = entries.find((x) => /\.(ogg|mp3|m4a)$/i.test(x.name));
    if (!e) throw new Error('谱包里没有音频条目');
    return { bytes: await readZipEntry(url, e), mime: mimeOf(e.name), name: e.name };
  })();
  audioCache.set(url, p);
  // 失败不要留下坏缓存，否则后续重试会一直拿到同一个 rejected promise
  p.catch(() => audioCache.delete(url));
  return p;
}

/**
 * 按需取音频/曲绘。
 *
 * 音频同时给出两种形态：
 *   · audioBytes —— 原始字节，交给 Web Audio 的 decodeAudioData 做真正的解析
 *     （波形、精确时长、BPM 检测、采样级回放都要它）
 *   · audioUrl   —— blob URL，供 <audio> 降级播放，也方便调试直接丢给浏览器
 * 调用方负责在不用时 revokeObjectURL。
 *
 * 音频字节按 .mcz 地址走模块级缓存，同一首歌的多个难度共用一份；
 * 曲绘不缓存 —— 它只有几十 KB，且每次都要新建 blob URL 给 CSS 变量用。
 *
 * @param {string} url
 * @param {{audio?:boolean, cover?:boolean}} opts
 * @returns {Promise<{audioUrl:string|null, audioBytes:Uint8Array|null, audioMime:string|null, coverUrl:string|null}>}
 */
export async function fetchAssets(url, { audio = false, cover = false } = {}) {
  let audioUrl = null;
  let audioBytes = null;
  let audioMime = null;
  let coverUrl = null;

  if (audio) {
    const got = await loadAudioBytes(url);
    audioBytes = got.bytes;
    audioMime = got.mime;
    audioUrl = URL.createObjectURL(new Blob([got.bytes], { type: audioMime }));
  }

  if (cover) {
    const entries = await readZipEntries(url);
    const e = entries.find((x) => /(^|\/)jkt[^/]*\.(png|jpe?g)$/i.test(x.name));
    if (e) {
      const bytes = await readZipEntry(url, e);
      coverUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(e.name) }));
    }
  }

  return { audioUrl, audioBytes, audioMime, coverUrl };
}

function mimeOf(name) {
  if (/\.ogg$/i.test(name)) return 'audio/ogg';
  if (/\.mp3$/i.test(name)) return 'audio/mpeg';
  if (/\.m4a$/i.test(name)) return 'audio/mp4';
  if (/\.png$/i.test(name)) return 'image/png';
  return 'image/jpeg';
}
