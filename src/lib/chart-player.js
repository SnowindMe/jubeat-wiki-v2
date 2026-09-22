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

// tap 动画时长 0.3s：出现后从整格满圈单向收缩，到中心即消失。
// 500ms 时相邻音符在视觉上会叠在一起，非双押也容易被读成双押，所以再收到 300ms。
const TAP_DURATION = 0.3; // tap 从出现到消失的总时长
// 收缩缓动：ease-out cubic。前段收得快（命中感强），尾段轻轻落定，
// 匀速会让中段显得拖沓 —— 同样的总时长，这样体感明显更利落。
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
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
 * 三角头朝向：0=右 1=下 2=左 3=上。
 * 取位移的主要分量（|Δcol| >= |Δrow| 走横向，否则纵向），
 * 同键长押没有位移，按「向右」处理即可（此时三角只是个端点标记）。
 */
function dirOf(h) {
  const a = keyPoint(h.key);
  const b = keyPoint(h.endKey);
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  if (Math.abs(dc) >= Math.abs(dr)) return dc < 0 ? 2 : 0;
  return dr < 0 ? 3 : 1;
}

const PAD_KEYS = 16;

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

  if (!pad.childElementCount) pad.innerHTML = padMarkup();
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

  /** 根号缓动：三角头起步快、落点收敛，避免线性插值的机械感 */
  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

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
      if (t < x.t) continue;
      if (t >= x.t + TAP_DURATION) continue;
      return { mode: 'tap', phase: (t - x.t) / TAP_DURATION, simul: x.simul, seq: x.seq };
    }
    return { mode: 'idle', phase: 0 };
  };

  /**
   * 把双押组号映射成一个稳定的色相，让「同时按的一组」一眼可辨。
   * 用黄金角跳色，相邻的组颜色差异明显且不依赖调色板。
   */
  const simulHue = (g) => (g * 137.508) % 360;

  function render(t) {
    for (let i = 0; i < keyEls.length; i++) {
      const el = keyEls[i];
      const st = stateOf(i + 1, t);
      el.classList.remove('is-tap', 'is-hold-head', 'is-hold-trail', 'is-hold-root', 'is-closing', 'is-simul');
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
        el.style.setProperty('--jp-anim', String(easeOutCubic(st.phase)));
        if (st.seq) el.dataset.jpSeq = String(st.seq);
      } else if (st.mode === 'hold-head') {
        el.classList.add('is-hold-head');
        if (st.rooted) el.classList.add('is-hold-root');
        el.style.setProperty('--jp-hold', String(st.phase));
        el.style.setProperty('--jp-dir', String(st.dir));
        if (st.seq) el.dataset.jpSeq = String(st.seq);
      } else if (st.mode === 'hold-trail') {
        el.classList.add('is-hold-trail');
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
        delete el.dataset.jpSeq;
      }
    }
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

  const status = root.querySelector('.jp-status');
  const gate = root.querySelector('.jp-gate');
  const gateBtn = gate?.querySelector('button');
  const setStatus = (text) => {
    if (status) status.textContent = text;
  };

  try {
    const url = await resolveMczUrl(root);
    if (!url) {
      root.dataset.state = 'missing';
      setStatus('仓库里没有找到这首曲目的铺面');
      if (gateBtn) gateBtn.disabled = true;
      return null;
    }

    const diff = normDiff(root.dataset.diff) ?? 'EXT';
    setStatus('正在从 CDN 读取谱面…');

    // 1) 只取三难度 .mc（Range，约 9 KB）
    const { charts } = await fetchChartSet(url, { bpm: Number(root.dataset.bpm) || null });
    const picked = charts[diff] ?? charts[Object.keys(charts)[0]];
    if (!picked) throw new Error('该谱包里没有 ' + diff + ' 难度');

    setStatus('正在解析音频（波形 / BPM）…');

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

    setStatus('');
    if (gate) gate.hidden = true;
    const controls = root.querySelector('.jp-controls');
    if (controls) controls.hidden = false;

    const mounted = mountChart(root, { ...picked, audioBuffer, peaks, tempo });
    root.__tempo = tempo;
    root.__audioInfo = audioInfo;
    return mounted;
  } catch (err) {
    root.dataset.state = 'error';
    setStatus('谱面加载失败：' + (err?.message ?? err));
    console.error('[jp] load failed', err);
    return null;
  } finally {
    root.__loading = false;
  }
}

/**
 * 页面上所有 .jp 自动准备：
 * 懒加载——先等用户点「加载预览」，或滚入视口后自动触发。
 * 注意选择器不要求 data-mcz：没内联地址的也要接管，交给前端兜底匹配。
 */
export async function mountAll() {
  const roots = [...document.querySelectorAll('.jp')];
  for (const root of roots) {
    if (root.__chart || root.__wired) continue;
    root.__wired = true;

    const gate = root.querySelector('.jp-gate');
    const gateBtn = gate?.querySelector('button');

    if (gateBtn) {
      gateBtn.addEventListener('click', () => loadAndMount(root));
    }

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
