// jubeat 铺面预览器：把 memo 解析结果渲染到 4x4 面板并按时间回放
// 设计约束：
//  - 无 JS 时页面仍可读（面板显示静态首屏，播放控件隐藏）
//  - 不依赖任何运行时库；由 Astro 在构建时把谱面数据以 JSON 内联
//  - 主题跟随站点已有的 light/dark 令牌，不引入新颜色变量

import { parseMemo, toTimeline } from './memo-parser.js';

const PAD_KEYS = 16;

/** 把 grid 里的 16 格渲染成按钮骨架（无 JS 时也可读） */
function padMarkup() {
  let html = '';
  for (let i = 0; i < PAD_KEYS; i++) {
    html += `<span class="jp-key" data-key="${i + 1}"></span>`;
  }
  return html;
}

/**
 * 挂载一个预览器实例。
 * @param {HTMLElement} root 容器（需含 .jp-pad / .jp-play 等子节点）
 * @param {{memo:string, bpm:number, label:string}} chart
 */
export function mountChart(root, chart) {
  const parsed = parseMemo(chart.memo);
  const { events, duration } = toTimeline(parsed, { bpm: Number(chart.bpm) || 120 });

  const pad = root.querySelector('.jp-pad');
  const playBtn = root.querySelector('.jp-play');
  const scrub = root.querySelector('.jp-scrub');
  const readout = root.querySelector('.jp-readout');
  if (!pad) return;

  if (!pad.childElementCount) pad.innerHTML = padMarkup();
  const keyEls = [...pad.querySelectorAll('.jp-key')];

  // 每个按键的“亮起”由 CSS 类驱动；用计时器维护
  const timers = [];
  let raf = 0;
  let startedAt = 0;
  let playing = false;
  let elapsed = 0;

  const clearTimers = () => { while (timers.length) clearTimeout(timers.pop()); };
  const clearAll = () => { keyEls.forEach((el) => el.classList.remove('is-hit')); };

  function frame() {
    if (!playing) return;
    elapsed = (performance.now() - startedAt) / 1000;
    if (elapsed >= duration) { stop(); return; }
    if (scrub) scrub.value = String(Math.round((elapsed / duration) * 1000));
    if (readout) readout.textContent = `${elapsed.toFixed(2)} / ${duration.toFixed(2)} s`;
    raf = requestAnimationFrame(frame);
  }

  function schedule() {
    clearTimers();
    const PLAY_MS = 160;
    // 按时间排好，逐个 setTimeout 触发
    const base = startedAt;
    for (const ev of events) {
      const delay = ev.time * 1000;
      if (delay < elapsed * 1000) continue;
      for (const k of ev.keys) {
        timers.push(setTimeout(() => {
          const el = keyEls[k - 1];
          if (!el) return;
          el.classList.add('is-hit');
          timers.push(setTimeout(() => el.classList.remove('is-hit'), PLAY_MS));
        }, delay));
      }
    }
  }

  function play() {
    if (playing) return;
    clearAll();
    playing = true;
    startedAt = performance.now() - elapsed * 1000;
    root.dataset.state = 'playing';
    if (playBtn) playBtn.textContent = '暂停';
    schedule();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    clearTimers();
    clearAll();
    root.dataset.state = 'idle';
    if (playBtn) playBtn.textContent = '播放';
  }

  function reset() {
    stop();
    elapsed = 0;
    if (scrub) scrub.value = '0';
    if (readout) readout.textContent = `0.00 / ${duration.toFixed(2)} s`;
  }

  playBtn?.addEventListener('click', () => (playing ? stop() : play()));
  root.querySelector('.jp-reset')?.addEventListener('click', reset);
  scrub?.addEventListener('input', () => {
    const wasPlaying = playing;
    stop();
    elapsed = (Number(scrub.value) / 1000) * duration;
    if (wasPlaying) play();
    else if (readout) readout.textContent = `${elapsed.toFixed(2)} / ${duration.toFixed(2)} s`;
  });

  // 首次进入视口时自动播放一次，便于主人“点开就能看到效果”
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { play(); io.disconnect(); }
      }
    }, { threshold: 0.4 });
    io.observe(root);
  }

  reset();
  // 暴露给调试与验收脚本
  root.__chart = { parsed, events, duration, play, stop, reset };
  return root.__chart;
}

/** 页面上所有 .jp[data-memo] 容器自动挂载（谱面数据内联在 data 属性之外的 script 里） */
export function mountAll() {
  const nodes = document.querySelectorAll('.jp[data-chart-id]');
  for (const root of nodes) {
    if (root.__chart) continue;
    const payload = document.getElementById(`jp-data-${root.dataset.chartId}`);
    if (!payload) continue;
    try {
      mountChart(root, JSON.parse(payload.textContent || '{}'));
    } catch (err) {
      root.dataset.state = 'error';
      const msg = root.querySelector('.jp-readout');
      if (msg) msg.textContent = '谱面解析失败';
      console.error('[jp] mount failed', err);
    }
  }
}
