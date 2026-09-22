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
//   tap   : 展开 475ms -> 收合 475ms，共 950ms
//   hold  : 起点按下 -> 三角朝起点收拢 -> 按住（保持发光）-> 终点处收合 80ms
//
// 约束：无 JS 时页面仍可读（面板空态 + 统计文字，控件不渲染）。

import { fetchChartSet, fetchAssets, normDiff } from './chart-source.js';
import { findMczForTitle } from './mcz-match.js';
import { analyzeAudio, AudioClockPlayer } from './chart-audio.js';

// tap 动画总时长 0.95s：前段展开（从整格满圈向内收缩），后段收合消失。
const TAP_DURATION = 0.95; // tap 从出现到消失的总时长
const TAP_OPEN = TAP_DURATION * 0.5; // tap 展开
const TAP_CLOSE = TAP_DURATION * 0.5; // tap 收合
const HOLD_CLOSE = 0.08; // 长押终点后收合
const HOLD_FOLD_RATIO = 0.25; // 三角收拢占长押时长的比例
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

  /** 某键在 t 时刻的状态 */
  const stateOf = (key, t) => {
    // 长押优先（时长更长）
    for (const h of holds) {
      // 长押是「按住不放」：整段都停在起点格上，与 endKey 无关。
      // endKey 是 pad 模式字段，不参与面板渲染。
      if (h.key !== key) continue;
      if (t < h.t) continue;
      if (t >= h.endT) {
        if (t < h.endT + HOLD_CLOSE) return { mode: 'closing', phase: (t - h.endT) / HOLD_CLOSE };
        continue;
      }
      const span = Math.max(h.endT - h.t, 1e-6);
      const foldEnd = h.t + span * HOLD_FOLD_RATIO;
      if (t < foldEnd) return { mode: 'fold', phase: (t - h.t) / Math.max(foldEnd - h.t, 1e-6) };
      return { mode: 'held', phase: 1 };
    }
    // 普通 tap
    for (const x of taps) {
      if (x.key !== key) continue;
      const total = TAP_OPEN + TAP_CLOSE;
      if (t < x.t) continue;
      if (t >= x.t + total) continue;
      return { mode: 'tap', phase: (t - x.t) / total };
    }
    return { mode: 'idle', phase: 0 };
  };

  function render(t) {
    for (let i = 0; i < keyEls.length; i++) {
      const el = keyEls[i];
      const st = stateOf(i + 1, t);
      el.classList.remove('is-tap', 'is-fold', 'is-held', 'is-closing');
      if (st.mode === 'tap') {
        const grow = st.phase < 0.5 ? st.phase / 0.5 : (1 - st.phase) / 0.5;
        el.classList.add('is-tap');
        el.style.setProperty('--jp-anim', String(grow));
      } else if (st.mode === 'fold') {
        el.classList.add('is-fold');
        el.style.setProperty('--jp-hold', String(st.phase));
      } else if (st.mode === 'held') {
        el.classList.add('is-held');
        el.style.setProperty('--jp-hold', '1');
      } else if (st.mode === 'closing') {
        el.classList.add('is-closing');
        el.style.setProperty('--jp-anim', String(1 - st.phase));
      } else {
        el.style.setProperty('--jp-anim', '0');
        el.style.setProperty('--jp-hold', '0');
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
