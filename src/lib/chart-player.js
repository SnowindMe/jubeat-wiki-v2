// jubeat 铺面预览器：渲染 4x4 面板 + 音频同步回放
//
// 数据来源（运行时，纯前端）：
//   页面只渲染一个带 data-mcz / data-song-id / data-song-title 的空壳；
//   用户点「▶ 加载预览」时：
//     1) 若 data-mcz 为空，用全量清单 + 曲名在前端匹配一次（mcz-match.js）
//     2) Range 读 .mcz 的中央目录与三难度 .mc（约 9 KB），解压后渲染
//     3) 取 bgm.ogg 解成 AudioBuffer —— 拿精确时长、波形峰值、BPM/首拍偏移
//
// 时钟模型（关键）：
//   回放的唯一时间轴是 Web Audio 的 ctx.currentTime，不是 <audio>.currentTime。
//   谱面的拍位秒数、进度条、波形播放头、4x4 动画全部由它推算，
//   所以「铺面和歌对齐」是结构性保证，不靠逐帧校正。
//
// 互斥：同一时间只允许一个预览器出声。任一预览器开始播放时，
//       其余预览器会被暂停（见 activePlayer 全局注册表）。
//
// 动画模型（对照官方手感）：
//   tap   : 出现后单向向内收缩，500ms 内用 ease-out 曲线收到中心即消失
//   hold  : 起点按下 -> 三角朝起点收拢 -> 按住（保持发光）-> 终点处收合 80ms
//
// 约束：无 JS 时页面仍可读（面板空态 + 统计文字，控件不渲染）。

import { fetchChartSet, fetchAssets, normDiff } from './chart-source.js';
import { findMczForTitle } from './mcz-match.js';
import { analyzeAudio, AudioClockPlayer } from './chart-audio.js';
import { setByteSink, clearByteSink } from './mcz-reader.js';

// tap 动画时长 0.3s：出现后从整格满圈单向收缩，到中心即消失。
// 500ms 时相邻音符在视觉上会叠在一起，非双押也容易被读成双押，所以再收到 300ms。
const TAP_DURATION = 0.3; // tap 从出现到消失的总时长
// 收缩缓动：ease-out cubic。前段收得快（命中感强），尾段轻轻落定，
// 匀速会让中段显得拖沓 —— 同样的总时长，这样体感明显更利落。
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
// 判定点后的淡出时长。与出现阶段分开算：出现用 --jp-anim 从四角合拢，
// 淡出用 --jp-passed 原地变透明，两个变量各自单调，互不干扰。
const TAP_PASSED_DURATION = 0.18;
// 缓入缓出：三角头起步快、落点收敛，避免线性插值的机械感。
// 放在模块作用域是因为带子层的几何生成（bandMarkup）也要用它。
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const HOLD_CLOSE = 0.08; // 长押终点后收合
// —— 长押：起点长按 + 三角头沿路径前进 + 连接线随之前进缩短 ——
// 前进占比按拍长自适应：0.5 拍也得动得出，12 拍也不能整段都在动。
const HOLD_SLIDE_PER_BEAT = 0.5; // 每拍分配 50% 行程
const HOLD_SLIDE_MIN = 0.22; // 前进最少占整段的比例
const HOLD_SLIDE_MAX = 0.45; // 前进最多占整段的比例
// 连接线保留比例：三角头走过的地方不留尾巴，线随之前进而缩短。
// 1.0 = 整条线一直留着；0.5 = 只保留后半段。
const HOLD_LINE_TAIL = 0.55;
const PAD_LINE_STEPS = 12; // 连接线插值步数（足够覆盖 3 格对角）
const PAD_COLS = 4;

/** 格号 1..16 -> {row, col}（1-based） */
function keyPoint(k) {
  return { row: Math.floor((k - 1) / PAD_COLS) + 1, col: ((k - 1) % PAD_COLS) + 1 };
}

/**
 * 长押行进方向，返回 'right' | 'down' | 'left' | 'up'。
 * 取位移的主要分量（|Δcol| >= |Δrow| 走横向，否则纵向）；
 * 同键长押没有位移，按 right 处理即可（此时三角只是个端点标记）。
 *
 * 为什么返回字符串而不是 0..3 的数字：方向要经 data-jp-dir 属性落到格子上，
 * CSS 侧用 `.jp-key.is-hold-root[data-jp-dir="right"]::before` 逐条匹配四个方向的
 * 缺口。属性选择器只能比字符串；写数字就得靠 `[style*="--jp-dir: 0"]` 去猜行内
 * style，既脆又会被无关的行内变量误命中。字符串让 JS 与 CSS 共用同一套词，
 * 两端谁也不需要知道对方的编号约定。
 */
function dirOf(h) {
  const a = keyPoint(h.key);
  const b = keyPoint(h.endKey);
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  if (Math.abs(dc) >= Math.abs(dr)) return dc < 0 ? 'left' : 'right';
  return dr < 0 ? 'up' : 'down';
}

const PAD_KEYS = 16;

// —— 长押带子层（.jp-band SVG）的几何常量 ——
// 单位统一是「格宽的比例」，与面板实际像素无关：三角头 0.22 格长、
// 连接线半宽 0.018 格，这样面板放大缩小时形状比例不变，不用重算常量。
// 设计原则是「克制」—— 面板只有 4×4，元素一胖就把音符本身盖住了。
//
// 三角头长度为什么是 0.22 格：格心距在常见桌面宽度下约 81px（320px 面板
// → 格宽 75.5px），0.22 格 ≈ 16.6px，约占单格心距 20%。这是「一个小箭头」。
// 它必须是**固定格长、不随带子长度缩放**：否则跨 3 格的长押会长成一个
// 巨大的三角形把整条带子吞掉（早期写成 1.6 格 ≈ 121px，比一个格心距还长，
// 被 f.len * 0.8 的 min() 一夹就退化成「头尾相接的粗棍子」）。
const BAND_LINE_W = 0.018; // 连接线半宽（格）
const BAND_HEAD_LEN = 0.22; // 三角头长度（格）
const BAND_HEAD_W = 0.15; // 三角头底边半宽（格）

/**
 * 从「格心两点」算出一条带子的局部坐标系。
 * u = 前进方向单位向量，v = 其法向（左手系，用于把线/头铺开成有宽度的多边形）；
 * len = 两点距离。所有后续几何都在这个坐标系里算，避免每处重复开方。
 */
function bandFrame(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { ux: dx / len, uy: dy / len, vx: -dy / len, vy: dx / len, len };
}

/** 带子坐标系里「沿轴 t、偏离轴法向 s」的点换算回面板像素 */
function bandPoint(a, f, t, s) {
  return { x: a.x + f.ux * t + f.vx * s, y: a.y + f.uy * t + f.vy * s };
}

/** 取整到 0.1px：SVG 字符串会作为 innerHTML 的 diff key，抖动能避免无效重写 */
function svgPoint(p) {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}

/**
 * 读 16 个格子的实际中心（面板像素坐标），供 .jp-band 这层 SVG 使用。
 *
 * 为什么用 getBoundingClientRect 反算而不是按公式除：格子尺寸由 CSS grid +
 * aspect-ratio 决定，还受 gap(6px)、padding(8px)、窄屏断点影响，
 * 用公式算必然在某个断点上错位。直接量真实几何则天然跟随布局。
 *
 * 关键：坐标必须是 **SVG 自己的坐标系**。SVG 有 position:absolute; inset:0，
 * 所以 SVG 的 (0,0) 是 .jp-pad 的 padding box 左上角；而格心是相对 viewport
 * 量的。两者相减才能抵消面板在页面里的位置，且不把 padding 算进去。
 */
function measurePad(pad) {
  const padRect = pad.getBoundingClientRect();
  const els = [...pad.querySelectorAll('.jp-key')];
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      // 相对 SVG 原点（= pad 的 padding box 左上角）的格心
      x: r.left + r.width / 2 - padRect.left - pad.clientLeft,
      y: r.top + r.height / 2 - padRect.top - pad.clientTop,
      w: r.width,
    };
  });
}

/**
 * 生成整条带子层的 SVG 内容（连接线 + 三角头）。
 *
 * 几何约定（为什么这么画）：
 *   - 三角头尖端朝着 **起点** 方向指（即 -u 方向），底边两点在前进处 ——
 *     视觉上像一支「往回指」的箭头，与起点格上的三角缺口形状呼应。
 *   - 连接线画两段：起点到 tip 之前一段、base 之后一段，中间被三角头占住，
 *     所以线不会从三角头底下透出来。
 *   - 线宽/头宽都按格宽比例，格子小的时候自动变细，不会糊成一团。
 *
 * @param {Array<{x:number,y:number,w:number}>} pts 16 个格心（面板像素）
 * @param {Array<{h:object, phase:number}>} bands 当前活动的长押
 * @returns {string} SVG 内部标记；无带子时返回空串
 */
function bandMarkup(pts, bands) {
  const out = [];
  for (const { h, phase } of bands) {
    const p0 = pts[h.key - 1];
    const p1 = pts[h.endKey - 1];
    if (!p0 || !p1) continue;
    const f = bandFrame(p0, p1);
    if (f.len < 0.5) continue; // 同键长押没有位移，只需起点格高亮，不画带子
    const cell = (p0.w + p1.w) / 2 || 1;
    const headLen = Math.min(BAND_HEAD_LEN * cell, f.len * 0.8);
    const headHalf = BAND_HEAD_W * cell;
    const lineHalf = BAND_LINE_W * cell;
    // 三角头只在「可走行程」内前进，到终点时尖端正好压在终点格心
    const travel = Math.max(0, f.len - headLen);
    const tipT = easeInOut(phase) * travel;
    const baseT = tipT + headLen;
    const tip = bandPoint(p0, f, tipT, 0);
    const baseL = bandPoint(p0, f, baseT, headHalf);
    const baseR = bandPoint(p0, f, baseT, -headHalf);
    out.push(`<polygon class="jp-band-head" points="${svgPoint(tip)} ${svgPoint(baseL)} ${svgPoint(baseR)}"/>`);
    // 两段线（头之前 / 头之后）；用四边形而不是 line，好让线宽随格宽走
    const seg = (t0, t1) => {
      if (t1 - t0 < 0.5) return;
      const a = bandPoint(p0, f, t0, lineHalf);
      const b = bandPoint(p0, f, t1, lineHalf);
      const c = bandPoint(p0, f, t1, -lineHalf);
      const d = bandPoint(p0, f, t0, -lineHalf);
      out.push(`<polygon class="jp-band-line" points="${svgPoint(a)} ${svgPoint(b)} ${svgPoint(c)} ${svgPoint(d)}"/>`);
    };
    seg(0, tipT);
    seg(baseT, f.len);
  }
  return out.length ? out.join('') : '';
}

/** 当前正在出声的预览器。全局唯一，保证「不能同时播放」。 */
let activePlayer = null;

function padMarkup() {
  let html = '';
  for (let i = 0; i < PAD_KEYS; i++) html += `<span class="jp-key" data-key="${i + 1}"></span>`;
  return html;
}

// —— 前端兜底匹配：构建期索引没命中时，用全量清单再找一次 ——

let manifestPromise = null;

/** 拉取全量清单 + 已被索引占用的文件集合（模块级缓存，全页共享一次请求） */
function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const [list, index] = await Promise.all([
        fetch('/data/mcz/list.json')
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch('/data/mcz/index.json')
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
      ]);
      const used = new Set();
      for (const entry of Object.values(index || {})) {
        if (!entry) continue;
        const dir = entry.dir ?? '';
        const name = entry.file ?? entry.name ?? '';
        used.add(entry.path ?? (dir ? `${dir}/${name}` : name));
      }
      return { list: Array.isArray(list) ? list : [], used };
    })();
  }
  return manifestPromise;
}

/**
 * 解析某个预览器该用哪个 .mcz。
 * 页面若已内联地址（构建期命中）直接用；否则用曲名在清单里找。
 * @returns {Promise<string|null>}
 */
async function resolveMczUrl(root) {
  const inline = root.dataset.mcz;
  if (inline) return inline;

  const title = root.dataset.songTitle;
  if (!title) return null;

  try {
    const { list, used } = await loadManifest();
    if (!list.length) return null;
    const hit = findMczForTitle(list, title, { exclude: used });
    if (hit) {
      root.dataset.mcz = hit.url;
      root.dataset.mczTier = hit.tier;
      // 清单条目自带字节数（{d,n,s}）：加载条的分母，构建期索引没命中时靠它
      const size = Number(hit.entry?.s ?? hit.size ?? 0);
      if (size > 0) root.dataset.mczSize = String(size);
      return hit.url;
    }
  } catch {
    /* 兜底失败就按「没有谱面」处理 */
  }
  return null;
}

// —— 波形绘制 ——

/**
 * 把峰值画到 canvas 上，已播放部分用高亮色。
 * @param {HTMLCanvasElement} canvas
 * @param {{min:Float32Array,max:Float32Array,buckets:number}|null} peaks
 * @param {number} progress 0..1
 */
function drawWave(canvas, peaks, progress = 0) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!peaks) return;

  const style = getComputedStyle(canvas);
  const played = style.getPropertyValue('--w-hit').trim() || '#e8963c';
  const rest = style.getPropertyValue('--w-seam-soft').trim() || 'rgba(255,255,255,.22)';

  const n = peaks.buckets;
  const step = w / n;
  const mid = h / 2;
  const cut = progress * w;

  for (let i = 0; i < n; i++) {
    const x = i * step;
    const hi = Math.max(1, (1 - peaks.max[i]) * mid);
    const lo = Math.min(h - 1, (1 - peaks.min[i]) * mid);
    ctx.fillStyle = x <= cut ? played : rest;
    ctx.fillRect(x, hi, Math.max(0.8, step * 0.85), Math.max(1, lo - hi));
  }

  // 播放头
  ctx.fillStyle = played;
  ctx.fillRect(Math.min(w - 1, cut), 0, 1.5, h);
}

// —— 主挂载逻辑 ——

/**
 * 挂载一个预览器（音频由 Web Audio 驱动）。
 * @param {HTMLElement} root 容器
 * @param {{taps:Array, holds:Array, audioBuffer?:AudioBuffer, peaks?:object}} chart
 */
export function mountChart(root, chart) {
  const taps = chart.taps || [];
  const holds = chart.holds || [];

  const pad = root.querySelector('.jp-pad');
  const playBtn = root.querySelector('.jp-play');
  const resetBtn = root.querySelector('.jp-reset');
  const scrub = root.querySelector('.jp-scrub');
  const readout = root.querySelector('.jp-readout');
  const rateSel = root.querySelector('.jp-rate-select');
  const waveCanvas = root.querySelector('.jp-wave');
  if (!pad) return null;

  // 带子层 SVG 必须在重建格子**之前**取出来：
  // pad.innerHTML = padMarkup() 会连它一起冲掉。模板里已有这个空占位
  // （见 ChartPreview.astro），它是 .jp-pad 的第一个子元素，
  // 由 CSS 的 grid-area: 1 / 1 / -1 / -1 覆盖整个面板。
  // 这里只负责往里灌内容，不负责创建节点；没有这层就直接跳过，
  // 长押退化成「只有起点格高亮」，不会报错。
  const bandSvg = pad.querySelector('.jp-band');
  if (!pad.querySelector('.jp-key')) {
    // 只补格子，保留原有子元素顺序（SVG 仍在最前，才能钉住整个网格）
    pad.insertAdjacentHTML('beforeend', padMarkup());
  }
  const keyEls = [...pad.querySelectorAll('.jp-key')];

  // —— 音符编号与双押分组 ——
  // 序号：全谱递增（tap 与 hold 一起排，按时间先后），格内显示让玩家能对照谱面。
  // 双押组：拍位相同（容差 SIMUL_EPS）的 tap 归为一组，同组用同色高亮。
  //   只对 >=2 个成员的组生效 —— 单押不染色，避免满屏花。
  const SEQ_FIELDS = (() => {
    const all = [
      ...taps.map((x) => ({ kind: 'tap', t: x.t, key: x.key, ref: x })),
      ...holds.map((x) => ({ kind: 'hold', t: x.t, key: x.key, ref: x })),
    ].sort((a, b) => a.t - b.t || a.key - b.key);
    all.forEach((x, i) => { x.ref.seq = i + 1; });
    return all;
  })();

  // 同时押分组：按时间聚簇，簇内 >=2 个就给相同的 group 号
  const SIMUL_EPS = 0.03; // 30ms 内视为同时
  let groupNo = 0;
  {
    const sorted = SEQ_FIELDS.slice().sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].t - sorted[i].t <= SIMUL_EPS) j++;
      const size = j - i + 1;
      if (size >= 2) {
        groupNo++;
        for (let k = i; k <= j; k++) sorted[k].ref.simul = groupNo;
      }
      i = j + 1;
    }
  }
  const simulCount = groupNo;

  // 时间轴总长：优先用音频真实时长，没有音频时退回「最后一个音符 + 余量」
  const lastT = Math.max(0, ...taps.map((x) => x.t), ...holds.map((x) => x.endT));
  let duration = chart.audioBuffer?.duration || chart.duration || Math.max(1, lastT + 1.2);

  const player = chart.audioBuffer
    ? new AudioClockPlayer(chart.audioBuffer, {
        onEnded: () => {
          playing = false;
          elapsed = duration;
          updateTransport();
          if (activePlayer === player) activePlayer = null;
          root.dataset.state = 'ready';
        },
      })
    : null;

  let raf = 0;
  let playing = false;
  let elapsed = 0;

  const formatTime = (t) => `${t.toFixed(2)} / ${duration.toFixed(2)} s`;

  function updateTransport() {
    if (readout) readout.textContent = formatTime(elapsed);
    if (scrub) scrub.value = String(duration > 0 ? Math.round((elapsed / duration) * 1000) : 0);
    drawWave(waveCanvas, chart.peaks, duration > 0 ? elapsed / duration : 0);
    if (playBtn) playBtn.textContent = playing ? '暂停' : elapsed > 0 && elapsed < duration ? '继续' : '播放';
  }

  /**
   * 某键在 t 时刻的长押状态。
   *
   * jubeat 的长押是「长按」：手指按住起点格不放，整段都停在起点格。
   * 但谱面用 endindex 标出这条长押的**去向**，所以视觉上：
   *   - 起点格 = 长按位置，全程高亮（手指按在这里）。
   *   - 三角头沿起点 -> 终点的路径前进，标出「还要往哪边拖/长押指向」。
   *   - 连接线画在这条路径上，**随三角头前进而缩短**：三角头走到哪，
   *     尾巴就从起点收到哪；滑到终点后整条线收完，只剩起点格保持按住。
   *
   * 时间分配：前进占整段的比例按拍长自适应（长押久一点才看得清），
   * 但有上下限 —— 0.5 拍的极短 hold 也得动得出、12 拍的长 hold 也不能一直在动。
   */
  const holdAt = (h, t) => {
    const span = Math.max(h.endT - h.t, 1e-6);
    const slideRatio = Math.min(HOLD_SLIDE_MAX, Math.max(HOLD_SLIDE_MIN, h.beats * HOLD_SLIDE_PER_BEAT));
    const slideEnd = h.t + span * slideRatio;
    if (t >= h.endT) {
      if (t < h.endT + HOLD_CLOSE) return { phase: 1, closing: (t - h.endT) / HOLD_CLOSE };
      return null;
    }
    const p = t <= h.t ? 0 : t >= slideEnd ? 1 : (t - h.t) / Math.max(slideEnd - h.t, 1e-6);
    return { phase: p, closing: 0 };
  };

  /** 三角头当前所在格号（1..16） */
  const headKeyAt = (h, phase) => {
    if (h.key === h.endKey) return h.key;
    const a = keyPoint(h.key);
    const b = keyPoint(h.endKey);
    const p = easeInOut(phase);
    const col = Math.round(a.col + (b.col - a.col) * p);
    const row = Math.round(a.row + (b.row - a.row) * p);
    return (row - 1) * 4 + col;
  };

  /**
   * 连接线覆盖的格号：三角头当前位置附近的一小段。
   * 关键：线随三角头前进而缩短 —— 三角头走过的地方不留尾巴，
   * 所以这里取「头部附近窗口」而不是「起点到头部全程」。
   */
  const trailAt = (h, phase) => {
    if (h.key === h.endKey) return [];
    if (phase >= 1) return [];
    const a = keyPoint(h.key);
    const b = keyPoint(h.endKey);
    const out = [];
    for (let i = 0; i <= PAD_LINE_STEPS; i++) {
      const p = easeInOut(i / PAD_LINE_STEPS);
      const col = Math.round(a.col + (b.col - a.col) * p);
      const row = Math.round(a.row + (b.row - a.row) * p);
      const k = (row - 1) * 4 + col;
      if (out[out.length - 1] !== k) out.push(k);
    }
    // 把整条路径按 phase 切成「已走过 / 未走过」，只保留已走过的那一段（即头后方）
    const travelled = Math.max(0, Math.round(out.length * phase));
    if (travelled <= 0) return [];
    // 尾巴也收：只保留头后 HOLD_LINE_TAIL 比例的那一段
    const seg = out.slice(0, travelled);
    const keep = Math.max(1, Math.ceil(seg.length * HOLD_LINE_TAIL));
    return seg.slice(-keep);
  };

  const stateOf = (key, t) => {
    // 长押优先（时长更长）
    for (const h of holds) {
      if (t < h.t) continue;
      const st = holdAt(h, t);
      if (!st) continue;
      const head = headKeyAt(h, st.phase);
      // 起点格 = 长按位置，整段都按住；三角头走到起点格时它同时也是 head
      if (h.key === key) {
        if (st.closing) return { mode: 'closing', phase: st.closing };
        if (head === key) return { mode: 'hold-head', phase: st.phase, dir: dirOf(h), rooted: true, simul: h.simul, seq: h.seq };
        return { mode: 'hold-root', phase: st.phase, simul: h.simul, seq: h.seq };
      }
      if (st.closing) continue;
      if (head === key) return { mode: 'hold-head', phase: st.phase, dir: dirOf(h), rooted: false, simul: h.simul, seq: h.seq };
      if (trailAt(h, st.phase).includes(key)) return { mode: 'hold-trail', phase: st.phase, simul: h.simul, seq: h.seq };
    }
    // 普通 tap
    for (const x of taps) {
      if (x.key !== key) continue;
      // 判定点之后进入「就地淡出」阶段：这段用 --jp-passed 驱动，
      // 与出现阶段的 --jp-anim 分开，这样「闭合到满格」和「淡出」是两段独立的节奏。
      const passed = t - x.t - TAP_DURATION;
      if (t < x.t) continue;
      if (passed >= TAP_PASSED_DURATION) continue;
      return {
        mode: 'tap',
        phase: (t - x.t) / TAP_DURATION,
        phasePassed: passed >= 0,
        fade: passed <= 0 ? 0 : passed / TAP_PASSED_DURATION,
        simul: x.simul,
        seq: x.seq,
      };
    }
    return { mode: 'idle', phase: 0 };
  };

  /**
   * 把双押组号映射成一个稳定的色相，让「同时按的一组」一眼可辨。
   * 用黄金角跳色，相邻的组颜色差异明显且不依赖调色板。
   */
  const simulHue = (g) => (g * 137.508) % 360;

  // 每帧重设前要清掉的「状态类」。类名必须与 ChartPreview.astro 里真正有样式的
  // 选择器一一对应：多留一个不存在的类（比如旧版的 is-hold-head / is-hold-trail）
  // 不会报错，只会静默不生效 —— 长押看上去就只剩起点高亮，方向缺口永远是默认朝右。
  //
  // is-tap-passed 必须在这里：它只在「判定点之后 0.18s」这一个窗口内被 add（见下方
  // render 的 tap 分支），但 tap 窗口结束后该格子走 else 分支，那里只 removeProperty，
  // 不会摘 class。漏掉它的话，判过一次的格子会永远留着实色背景与发光描边
  //（.jp-key.is-tap.is-tap-passed 那条规则），下一次同一格出现音符就直接是「已判定」
  // 的实色外观，动画看起来像坏掉。
  const STATE_CLASSES = ['is-tap', 'is-tap-passed', 'is-hold-head', 'is-hold-end', 'is-hold-root', 'is-closing', 'is-simul'];

  /**
   * 把「当前所有活动长押」渲染成 SVG 带子。
   *
   * 为什么每帧重算而不是增量维护：长押在任意时刻可能多条并行
   * （如 Insanity: Luna EXT 1.22s 处 6 条同时推进），每条的头位置都在变，
   * 增量维护要处理新增/消失/头位移三套 diff，反而更容易漏。整帧重算 + 字符串
   * 比对，只有内容真变了才写 DOM（__ink 缓存上次内容），实测开销可忽略。
   *
   * 颜色：CSS 里写的是 var(--jp-hit) / var(--jp-hit-deep)，但这两个变量
   * 原本只定义在文档根上，SVG 里用 color-mix() 会解析失败回落成黑色，
   * 所以这里从 documentElement 读出实色后用内联 fill/stroke 直接落到 polygon 上。
   */
  function syncBands(t) {
    if (!bandSvg) return;
    const bands = [];
    for (const h of holds) {
      if (t < h.t) continue;
      if (t >= h.endT + HOLD_CLOSE) continue;
      const st = holdAt(h, t);
      if (!st) continue;
      bands.push({ h, phase: st.phase });
    }
    const markup = bands.length ? bandMarkup(measurePad(pad), bands) : '';
    // 只有内容变化才写 innerHTML：每帧无条件重写会让 SVG 反复重建，
    // 在 60fps 下是白白烧 CPU。
    if (bandSvg.__ink !== markup) {
      bandSvg.innerHTML = markup;
      bandSvg.__ink = markup;
      // 颜色变量随内容一起落，避免在同一帧里读两次 computed style
      if (markup) {
        const cs = getComputedStyle(document.documentElement);
        const hit = cs.getPropertyValue('--w-hit').trim() || '#38c6e6';
        const deep = cs.getPropertyValue('--w-hit-deep').trim() || '#1490b4';
        pad.style.setProperty('--jp-hit', hit);
        pad.style.setProperty('--jp-hit-deep', deep);
      }
    }
  }

  function render(t) {
    for (let i = 0; i < keyEls.length; i++) {
      const el = keyEls[i];
      const st = stateOf(i + 1, t);
      el.classList.remove(...STATE_CLASSES);
      // 方向是「当前这一帧的属性」，不是状态位的累加：清干净再按需写回，
      // 否则长押走过去之后，格子会留着上一根长押的方向，缺口指错。
      delete el.dataset.jpDir;
      // 双押提示：同组共用同一个色相变量，单押不染色
      if (st.simul) {
        el.classList.add('is-simul');
        el.style.setProperty('--jp-simul', String(Math.round(simulHue(st.simul))));
      } else {
        el.style.removeProperty('--jp-simul');
      }
      if (st.mode === 'tap') {
        // 单向收缩 + ease-out：整段单调 0 -> 1，收缩到中心即消失，不做反向散开。
        el.classList.add('is-tap');
        el.style.setProperty('--jp-anim', String(easeOutCubic(Math.min(1, st.phase))));
        // 判定点之后：整格转为实色并就地淡出。--jp-passed 从 0 单调到 1，
        // CSS 用它做 opacity 与收缩的收边（.jp-key.is-tap.is-tap-passed）。
        if (st.phasePassed) {
          el.classList.add('is-tap-passed');
          el.style.setProperty('--jp-passed', String(st.fade));
        } else {
          el.style.removeProperty('--jp-passed');
        }
        if (st.seq) el.dataset.jpSeq = String(st.seq);
      } else if (st.mode === 'hold-head') {
        // 三角头所在格。rooted = 头还压在起点格上（此时起点格同时也是头）。
        // 用 is-hold-root 而不是旧版的 is-hold-head：新 CSS 里只有 is-hold-root
        // 定义了那个「朝行进方向开口的三角缺口」。
        if (st.rooted) el.classList.add('is-hold-root');
        el.classList.add('is-hold-end');
        el.style.setProperty('--jp-hold', String(st.phase));
        // 方向以 data-jp-dir 落到格子上，供 CSS 的属性选择器匹配缺口朝向。
        el.dataset.jpDir = st.dir;
        if (st.seq) el.dataset.jpSeq = String(st.seq);
      } else if (st.mode === 'hold-trail') {
        // 长条中段：被头扫过的格。CSS 里没有专门的 trail 样式，走的还是
        // is-hold-end 那条「一圈描边」——中段连成带子，头尾各自有描边。
        el.classList.add('is-hold-end');
        el.style.setProperty('--jp-hold', String(st.phase));
      } else if (st.mode === 'hold-root') {
        el.classList.add('is-hold-root');
        el.style.setProperty('--jp-hold', String(st.phase));
      } else if (st.mode === 'closing') {
        el.classList.add('is-closing');
        el.style.setProperty('--jp-anim', String(1 - st.phase));
      } else {
        el.style.setProperty('--jp-anim', '0');
        el.style.setProperty('--jp-hold', '0');
        el.style.removeProperty('--jp-passed');
        delete el.dataset.jpSeq;
      }
    }
    // 带子层：整帧一次性重算，而不是逐格各写一段 ——
    // 长押是一根跨格不断的连续结构，逐格画必然在 6px 间隙里断开。
    syncBands(t);
  }

  /** 每帧：时间轴来自音频采样级时钟，谱面严格跟着它走 */
  function tick() {
    if (!playing) return;
    elapsed = player ? player.currentTime : Math.min(duration, elapsed + 1 / 60);
    if (elapsed >= duration) {
      playing = false;
      elapsed = duration;
      updateTransport();
      render(elapsed);
      return;
    }
    render(elapsed);
    updateTransport();
    raf = requestAnimationFrame(tick);
  }

  function start() {
    // 互斥：先把别人停掉，保证同一时间只有一个难度在出声
    if (activePlayer && activePlayer !== player && activePlayer.__pause) {
      activePlayer.__pause();
    }
    activePlayer = player;
    playing = true;
    root.dataset.state = 'playing';
    if (player) {
      player.__pause = () => {
        player.pause();
        playing = false;
        cancelAnimationFrame(raf);
        updateTransport();
        root.dataset.state = 'ready';
      };
      player.play();
    }
    updateTransport();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    if (player) player.pause();
    cancelAnimationFrame(raf);
    updateTransport();
    root.dataset.state = 'ready';
    if (activePlayer === player) activePlayer = null;
  }

  // 点击播放器以外的任意位置即暂停：预览是辅助工具，不应该在用户去看别处时还在响。
  // 用捕获阶段 + pointerdown，比 click 更早、且能覆盖拖拽/长按。
  const onDocPointerDown = (e) => {
    if (!playing) return;
    if (root.contains(e.target)) return;
    pause();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  root.__unbindOutside = () => document.removeEventListener('pointerdown', onDocPointerDown, true);

  playBtn?.addEventListener('click', () => {
    if (playing) pause();
    else {
      if (elapsed >= duration) elapsed = 0;
      start();
    }
  });

  resetBtn?.addEventListener('click', () => {
    playing = false;
    cancelAnimationFrame(raf);
    if (player) {
      player.pause();
      player.seek(0);
    }
    elapsed = 0;
    updateTransport();
    render(0);
    root.dataset.state = 'ready';
    if (activePlayer === player) activePlayer = null;
  });

  // 拉进度条 = 直接 seek 音频与谱面的共同时间轴
  scrub?.addEventListener('input', () => {
    const ratio = Number(scrub.value) / 1000;
    elapsed = ratio * duration;
    if (player) player.seek(elapsed);
    render(elapsed);
    updateTransport();
  });

  rateSel?.addEventListener('change', () => {
    const rate = Number(rateSel.value) || 1;
    if (player) player.setRate(rate);
  });

  root.__chart = { taps, holds, duration };
  root.__player = player;
  root.__stop = () => {
    if (playing) pause();
    root.__unbindOutside?.();
    player?.dispose();
  };

  updateTransport();
  render(0);
  root.dataset.state = 'ready';
  return root.__chart;
}

/**
 * 为一个预览器从 CDN 加载谱面、音频，然后挂载。
 * @param {HTMLElement} root
 */
export async function loadAndMount(root) {
  if (root.__chart || root.__loading) return root.__chart ?? null;
  root.__loading = true;
  root.dataset.state = 'loading';

  // 本次加载的身份。难度切换与快速连点会让多次加载重叠，只有 identity
  // 仍然最新的那次才允许写 DOM —— 否则慢返回的旧响应会覆盖新难度。
  const identity = (root.__loadToken = (root.__loadToken ?? 0) + 1);
  const isStale = () => root.__loadToken !== identity;

  const status = root.querySelector('.jp-status');
  const gate = root.querySelector('.jp-gate');
  const gateBtn = gate?.querySelector('button');

  // —— 加载条 ——
  // 分母 = 整包字节数（构建期索引/data-mcz-size，与线上逐条实测一致），
  // 分子 = mcz-reader 每读完一段 Range 就上报的实收字节累计。
  // 谱面 ~9 KB、曲绘几十 KB、音频占 95% 以上，所以「已下载 / 整包」这条曲线
  // 基本就是真实完成度；多节点实测探测与波形分析不上报字节，由阶段切换补推。
  const totalBytes = Number(root.dataset.mczSize) || 0;
  const bar = root.querySelector('.jp-bar');
  const barFill = root.querySelector('.jp-bar-fill');
  let gotBytes = 0;
  let lastPct = 0;
  let phaseLabel = '正在从 CDN 读取谱面…';

  const paint = (pct) => {
    if (!bar || !barFill) return;
    // 只许前进：Range 分包 + 节点重试会有重复区间，实收字节可能略超整包
    const next = Math.max(lastPct, Math.min(pct, 1));
    lastPct = next;
    bar.hidden = false;
    if (totalBytes > 0) {
      barFill.style.width = (next * 100).toFixed(1) + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(next * 100)));
    } else {
      // 分母未知：退化成不确定态（CSS 动画来回跑），别卡在 0% 装死
      bar.classList.add('is-indeterminate');
    }
  };

  const renderStatus = () => {
    if (!status || isStale()) return;
    // 读数只在「有分母、已开始、还没读完」时附上，避免 0 / -- 这种噪音
    const withBytes =
      totalBytes > 0 && gotBytes > 0 && lastPct > 0 && lastPct < 1
        ? `（${(gotBytes / 1048576).toFixed(2)} / ${(totalBytes / 1048576).toFixed(2)} MB）`
        : '';
    status.textContent = phaseLabel + withBytes;
  };

  const setStatus = (text) => {
    phaseLabel = text;
    renderStatus();
  };

  // 每段 Range 读完都会回调：更新字节读数与进度条。owner 令旧加载只能
  // 注销自己的回调，不能清掉后来接管单槽的新加载。
  const sinkOwner = {};
  setByteSink((n) => {
    gotBytes += n;
    if (isStale()) return;
    paint(totalBytes > 0 ? gotBytes / totalBytes : 0);
    renderStatus();
  }, sinkOwner);

  // 加载中先把按钮收起：这块区域交给进度条，也避免「明明在加载还能再点一次」
  if (gateBtn) gateBtn.hidden = true;

  try {
    const url = await resolveMczUrl(root);
    if (isStale()) return null;
    if (!url) {
      root.dataset.state = 'missing';
      root.__missing = true;
      setStatus('仓库里没有找到这首曲目的铺面');
      if (gateBtn) gateBtn.disabled = true;
      return null;
    }
    // 曾经因兜底匹配失败被标过 missing，这次拿到地址了就撤掉标记，
    // 否则 mountAll 的 IntersectionObserver 分支会一直跳过这个容器。
    root.__missing = false;

    const diff = normDiff(root.dataset.diff) ?? 'EXT';
    setStatus('正在从 CDN 读取谱面…');

    // 1) 只取三难度 .mc（Range，约 9 KB）
    root.__phase = 'fetchChartSet';
    const { charts } = await fetchChartSet(url, { bpm: Number(root.dataset.bpm) || null });
    if (isStale()) return null;
    const picked = charts[diff] ?? charts[Object.keys(charts)[0]];
    if (!picked) throw new Error('该谱包里没有 ' + diff + ' 难度');

    setStatus('正在解析音频（波形 / BPM）…');
    root.__phase = 'fetchAssets';

    // 2) 音频 + 曲绘。音频要拿到原始字节用来 decode，不只是给 <audio> 的 blob URL。
    let audioBuffer = null;
    let peaks = null;
    let tempo = null;
    let audioInfo = null;
    let audioUrl = null;

    try {
      const assets = await fetchAssets(url, { audio: true, cover: true });
      audioUrl = assets.audioUrl;

      if (assets.coverUrl) {
        root.style.setProperty('--jp-cover', `url("${assets.coverUrl}")`);
        root.classList.add('has-cover');
        root.__coverUrl = assets.coverUrl;
      }

      if (assets.audioBytes) {
        root.__audioUrl = assets.audioUrl;
        // BPM 以谱面为准：.mc 自带 bpms，其次用曲目数据里的 bpm。
        // 音频自相关只用来求首拍相位，避免倍速/半速歧义把 BPM 带偏。
        const anchorBpm = picked.bpm ?? (Number(root.dataset.bpm) || null);
        const analyzed = await analyzeAudio(assets.audioBytes, {
          buckets: 1200,
          maxSeconds: 90,
          bpm: anchorBpm,
        });
        audioBuffer = analyzed.buffer;
        peaks = analyzed.peaks;
        tempo = analyzed.tempo;
        audioInfo = analyzed.info;
      }
    } catch (err) {
      // 音频失败不阻塞谱面回放：没有音频时退回「按谱面时长空转」
      console.warn('[jp] 音频解析失败，退回无音频模式', err);
      setStatus('音频解析失败，仅回放谱面');
    }

    // 统计文字。注意：.jp-audio 是 .jp-meta 的子元素，不能整段重写 innerHTML，
    // 否则会把 .jp-audio 从 DOM 里抹掉，导致后面的音频信息无处可写。
    // 到这里已经跨过音频解析的 await，必须再确认一次身份：难度被切走时
    // 这些回写会盖掉新难度已经渲染好的面板。
    if (isStale()) return null;
    const stats = root.querySelector('.jp-meta');
    if (stats) {
      // 清掉构建期的占位符（「谱面数据将在加载后显示」），此时已经有真实数据了
      stats.querySelector('.jp-note-dim')?.remove();
      const n = picked.stats?.noteCount ?? picked.taps.length + picked.holds.length;
      let metaLead = stats.querySelector('.jp-meta-lead');
      if (!metaLead) {
        metaLead = document.createElement('span');
        metaLead.className = 'jp-meta-lead';
        stats.insertBefore(metaLead, stats.firstChild);
      }
      metaLead.textContent =
        `音符 ${n}（按键 ${picked.taps.length} · 长押 ${picked.holds.length}）` +
        (root.dataset.levelTag ?? '');
    }
    // 音频信息（时长 / 采样率 / 检测到的 BPM）+ 原始 blob 便于核对
    const audioLine = root.querySelector('.jp-audio');
    if (audioLine) {
      const bits = [];
      if (audioInfo) {
        bits.push(`音频 ${audioInfo.duration.toFixed(2)}s`);
        bits.push(`${audioInfo.sampleRate} Hz`);
        bits.push(`${audioInfo.channels}ch`);
      }
      if (tempo?.bpm) {
        // 有谱面锚点时是「谱面 BPM」，否则才是纯音频实测值
        bits.push(tempo.anchored ? `BPM ${tempo.bpm.toFixed(1)}` : `实测 BPM ${tempo.bpm.toFixed(1)}`);
        bits.push(`首拍 ${tempo.offset.toFixed(2)}s`);
      }
      audioLine.textContent = bits.length ? ' · ' + bits.join(' · ') : '';
      audioLine.title = audioUrl ?? '';
    }

    if (isStale()) return null;
    paint(1);
    setStatus('');
    if (gate) gate.hidden = true;
    const controls = root.querySelector('.jp-controls');
    if (controls) controls.hidden = false;

    const mounted = mountChart(root, { ...picked, audioBuffer, peaks, tempo });
    if (isStale()) return null;
    root.__tempo = tempo;
    root.__audioInfo = audioInfo;
    return mounted;
  } catch (err) {
    if (isStale()) return null;
    root.dataset.state = 'error';
    setStatus('谱面加载失败：' + (err?.message ?? err));
    // 失败时把进度条收掉、按钮放回来：停在半路的条子会被误读成「还在加载」
    if (bar) bar.hidden = true;
    if (gateBtn) gateBtn.hidden = false;
    console.error('[jp] load failed', err);
    // 诊断留痕：把异常全貌（含 name/cause/stack 首帧）挂到 root 上，便于 CDP 抓取。
    // 只挂数据、不改流程；验收完可以删掉。
    try {
      root.__error = {
        name: err?.name ?? typeof err,
        message: String(err?.message ?? err),
        cause: err?.cause ? `${err.cause.name}: ${err.cause.message}` : null,
        stack: String(err?.stack ?? '').split('\n').slice(0, 8).join(' | '),
        phase: root.__phase ?? null,
      };
    } catch { /* 诊断失败不影响主流程 */ }
    return null;
  } finally {
    // 只注销本次加载自己的回调；若已有更新的加载接管单槽，则保留它。
    clearByteSink(sinkOwner);
    // 只有最新的那次加载才有资格复位 __loading：旧加载提前退出时把标志清了，
    // 会让正在跑的新加载被后续调用当成「空闲」而重复进入。
    if (!isStale()) root.__loading = false;
  }
}

/**
 * 页面上所有 .jp 自动准备：
 * 懒加载——先等用户点「加载预览」，或滚入视口后自动触发。
 * 注意选择器不要求 data-mcz：没内联地址的也要接管，交给前端兜底匹配。
 */
export async function mountAll() {
  // 难度切换的两个入口（左侧 .jp-rail 与页面表格里的「▶ 预览」锚点）都用
  // document 级委托接线：它们在 .jp 容器重挂前后始终存在，委托只需挂一次。
  wireDiffSwitch();

  const roots = [...document.querySelectorAll('.jp')];
  for (const root of roots) {
    if (root.__chart || root.__wired) continue;
    root.__wired = true;

    const gate = root.querySelector('.jp-gate');
    const gateBtn = gate?.querySelector('button');

    if (gateBtn) {
      gateBtn.addEventListener('click', () => loadAndMount(root));
    }
    // 首次接线时按 data-diff 同步一次 aria-selected / tabindex，
    // 免得服务端渲染的默认难度与实际状态不一致。
    syncDiffUi(root);

    // 滚入视口后自动加载（若无手动按钮则直接自动）
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !root.__chart && !root.__loading && !root.__missing) {
              if (!gateBtn) loadAndMount(root);
              io.disconnect();
            }
          }
        },
        { threshold: 0.2 },
      );
      io.observe(root);
    } else if (!gateBtn) {
      loadAndMount(root);
    }
  }
}

/** 释放某个预览器占用的 blob URL */
export function releaseChart(root) {
  root.__stop?.();
  if (root.__audioUrl) URL.revokeObjectURL(root.__audioUrl);
  if (root.__coverUrl) URL.revokeObjectURL(root.__coverUrl);
  root.__audioUrl = null;
  root.__coverUrl = null;
}

// —— 难度切换 ——
//
// 页面侧（ChartPreview.astro）静态渲染了三个难度按钮（.jp-diff，data-jp-diff），
// 详情页表格里的「▶ 预览」锚点带 data-jp-jump。两者都必须能切到目标难度，
// 且共用下面这一段逻辑 —— 不写第二份。
//
// 为什么切换「只补 .mc」而不重下音频：loadAudioBytes（chart-source.js:145）的
// 缓存键就是 .mcz 的 CDN 地址，切难度时该地址与曲目 bpm 都不变，
// 所以 fetchAssets 必然命中缓存，只补下≈9KB 的 .mc。切换路径不要另建缓存，
// 也不要绕过 fetchAssets 自己取音频。

/** 把一个已经挂载的预览器摘干净，让 loadAndMount 可以重新接管 */
function unmountChart(root) {
  releaseChart(root);
  // loadAndMount 的入口护栏是 `if (root.__chart || root.__loading) return`，
  // releaseChart 并不清 __chart —— 不手动清掉的话重挂会被护栏挡回去，什么都不发生。
  root.__chart = null;
  root.__player = null;
  root.__tempo = null;
  root.__audioInfo = null;
  delete root.dataset.levelTag;
  root.classList.remove('has-cover');
  root.style.removeProperty('--jp-cover');
}

/** 难度切换后同步左侧难度栏的可访问性状态（aria-selected + roving tabindex） */
function syncDiffUi(root, diff) {
  const target = normDiff(diff ?? root.dataset.diff);
  const tabs = [...root.querySelectorAll('.jp-rail [role="tab"]')];
  if (!tabs.length) return;
  let activeTab = null;
  for (const tab of tabs) {
    const on = normDiff(tab.dataset.jpDiff) === target;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    // roving tabindex：整栏只留一个可 Tab 聚焦的停靠点，栏内用方向键移动。
    tab.tabIndex = on ? 0 : -1;
    if (on) activeTab = tab;
  }
  // 目标难度在栏里找不到按钮时（例如页面只给了部分难度），
  // 至少保证有且仅有一个停靠点，否则整栏会从键盘导航里消失。
  if (!activeTab) {
    tabs[0].tabIndex = 0;
    activeTab = tabs[0];
  }

  // 等级后缀：预览器的统计文字（loadAndMount 里读 root.dataset.levelTag）
  // 需要「当前难度的 Lv」。等级数据只存在于 rail 按钮自己的子树里
  // （ChartPreview.astro 的 <span class="jp-diff-lv">Lv 5</span>），
  // 这里从选中按钮上取回并落到 dataset —— 难度切换与首次挂载都会经过这里，
  // 所以写入端只此一处，不必改 ChartPreview.astro。
  const lv = activeTab?.querySelector('.jp-diff-lv')?.textContent?.trim();
  if (lv && lv !== '—') root.dataset.levelTag = ` · ${lv}`;
  else delete root.dataset.levelTag;

  // 头部标签（.jp-label）在服务端是按默认难度渲染死的，切换后必须跟着改，
  // 否则会出现「头写 EXTREME、面板画 BSC」的自相矛盾。名字与等级同样取自
  // rail 按钮，缺失时保留原文本而不是写空。
  const label = root.querySelector('.jp-label');
  if (label) {
    const name = activeTab?.querySelector('.jp-diff-name')?.textContent?.trim();
    const lvNum = lv && lv !== '—' ? lv.replace(/^Lv\s*/i, '') : '';
    if (name) label.textContent = lvNum ? `${name} ${lvNum}` : name;
  }
}

/** 按 roving tabindex 约定把焦点移到另一个难度按钮上 */
function focusDiffTab(tabs, index) {
  const next = tabs[(index + tabs.length) % tabs.length];
  if (!next) return;
  // 先把整栏清成 -1，再给目标置 0：必须两趟走完。
  // 写成一趟 tab === next ? 0 : tab.tabIndex 是错的 —— 非目标项只是把原值
  // 赋回自己，上一轮的 tabIndex=0 会留在那儿，整栏就会出现两个停靠点。
  for (const tab of tabs) tab.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

/**
 * 切换某个预览器的谱面难度。
 *
 * 幂等：目标难度与当前一致时直接返回，不重启播放（重复点击同一难度是常见误操作）。
 * 并发安全：每次切换都换一个 token，只有最新一次切换才允许继续走后续的重挂与回写；
 * 被取代的旧切换在 await 回来后自己退出，不会覆盖新难度的 DOM。
 *
 * @param {HTMLElement} root .jp 容器
 * @param {string} diff 目标难度（bsc/adv/ext，大小写不敏感）
 * @returns {Promise<unknown>}
 */
export async function switchDiff(root, diff) {
  if (!root) return null;
  const target = normDiff(diff);
  if (!target) return null;

  const current = normDiff(root.dataset.diff);
  // 幂等：已经是这个难度就什么都不做。注意这里必须早退于任何 abort / 重挂，
  // 否则重复点击会把正在播放的音频掐掉重启。
  if (current === target && root.__chart) {
    syncDiffUi(root, target);
    return root.__chart;
  }

  const token = (root.__switchToken = (root.__switchToken ?? 0) + 1);
  // 写小写：服务端（ChartPreview.astro 的 data-diff）渲染的就是 active.diff 的小写形态，
  // 这里跟着写小写才能让 DOM 只有一种约定；normDiff 在读侧做归一化，两边都不吃亏。
  root.dataset.diff = target.toLowerCase();

  // 在飞的谱面/音频请求必须作废：作废旧 token 的所有回写。
  // fetchWithRetry（mcz-reader.js）目前不接受 signal，所以这里用「逻辑取消」——
  // 旧切换在每次 await 回来时检查 token，发现已被取代就不再碰 DOM（见 loadAndMount
  // 的 isStale 与下面的返回值检查）。旧请求本身会自然结束（Range 只有几 KB），
  // 其结果被丢弃，绝不会覆盖新难度。
  unmountChart(root);
  // 旧加载的 finally 因为 isStale 不会复位 __loading；这里强制放开，
  // 否则新的 loadAndMount 会被入口护栏挡回去，点了没反应。
  root.__loading = false;

  // 同步难度栏必须放在 unmountChart 之后：unmountChart 里会 delete
  // root.dataset.levelTag，先写就会被它删掉，切完难度统计文字就丢了 Lv 后缀。
  syncDiffUi(root, target);

  const mounted = await loadAndMount(root);
  if (root.__switchToken !== token) return null; // 已被更新的切换取代，放弃回写
  return mounted;
}

let diffSwitchWired = false;

/** 给 .jp-rail 与 data-jp-jump 锚点接委托（document 级，只挂一次） */
function wireDiffSwitch() {
  if (diffSwitchWired || typeof document === 'undefined') return;
  diffSwitchWired = true;

  const rootOf = (el) => el?.closest?.('.jp') ?? null;

  document.addEventListener('click', (e) => {
    // 入口一：左侧难度栏的按钮
    const tab = e.target?.closest?.('.jp-rail [role="tab"]');
    if (tab) {
      const root = rootOf(tab);
      if (root) switchDiff(root, tab.dataset.jpDiff);
      return;
    }
    // 入口二：详情页表格里的「▶ 预览」锚点。href 指向 #preview-ext，
    // 浏览器负责滚动/定位，这里只负责把难度切过去 —— 与上面共用 switchDiff。
    const jump = e.target?.closest?.('[data-jp-jump]');
    if (jump) {
      const root = rootOf(jump) ?? document.querySelector('.jp');
      if (root) switchDiff(root, jump.dataset.jpJump);
    }
  });

  // 键盘：tablist 的方向键移动并自动激活，Home/End 同样切换难度；Enter/Space 由 click 覆盖。
  document.addEventListener('keydown', (e) => {
    const tab = e.target?.closest?.('.jp-rail [role="tab"]');
    if (!tab) return;
    const tabs = [...(tab.closest('.jp-rail')?.querySelectorAll('[role="tab"]') ?? [])];
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tabs[(i + 1 + tabs.length) % tabs.length];
      focusDiffTab(tabs, i + 1);
      switchDiff(rootOf(tab), next?.dataset.jpDiff);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = tabs[(i - 1 + tabs.length) % tabs.length];
      focusDiffTab(tabs, i - 1);
      switchDiff(rootOf(tab), next?.dataset.jpDiff);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusDiffTab(tabs, 0);
      switchDiff(rootOf(tab), tabs[0]?.dataset.jpDiff);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusDiffTab(tabs, tabs.length - 1);
      switchDiff(rootOf(tab), tabs.at(-1)?.dataset.jpDiff);
    }
  });
}

