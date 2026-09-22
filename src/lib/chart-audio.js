// 音频解析与回放（浏览器端，Web Audio）
//
// 为什么不用 <audio>：<audio> 只能「播」，拿不到 PCM，也没有采样级时钟。
// jubeat 谱面的时间轴是拍位换算出来的秒数，必须和音频落在同一根时间线上，
// 所以这里直接把 bgm.ogg 解成 AudioBuffer，自己做三件事：
//
//   1) decodeAudio()       —— decodeAudioData 解码，拿到精确时长/采样率/声道
//   2) computePeaks()      —— 分桶提峰值，给进度条画波形
//   3) detectTempo()       —— onset 包络 + 自相关，得到 BPM / 首拍偏移 / 置信度
//   4) AudioClockPlayer    —— AudioBufferSourceNode 回放，用 ctx.currentTime 做采样级时钟
//
// 全部纯前端，数据从 CDN 的 .mcz 里按需取，不需要任何后端。

/** 分析用的降采样率：11.025 kHz 足够做 onset 检测，又把自相关成本压到 1/4 */
const ANALYSIS_RATE = 11025;
/** onset 包络的帧移（样本数，按 ANALYSIS_RATE 计）：256 ≈ 23 ms */
const ONSET_HOP = 256;
/** BPM 搜索范围 */
const BPM_MIN = 60;
const BPM_MAX = 200;

let sharedCtx = null;

/** 取（或建）全局 AudioContext。解码不需要用户手势，suspended 状态也能解。 */
export function audioContext() {
  if (!sharedCtx) {
    const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) throw new Error('当前浏览器不支持 Web Audio');
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * 解码音频字节。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeAudio(bytes) {
  const ctx = audioContext();
  // decodeAudioData 会「吞掉」传入的 ArrayBuffer（detach），所以给一份独立副本，
  // 免得调用方之后还要用同一块内存。
  const ab =
    bytes instanceof ArrayBuffer
      ? bytes.slice(0)
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return await ctx.decodeAudioData(ab);
}

/** AudioBuffer 的基本信息（展示用） */
export function describeBuffer(buffer) {
  return {
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
  };
}

/**
 * 波形峰值：把第一个声道按桶切分，每桶取最小/最大值。
 * 返回两条长度相等的数组，画柱状波形时用 min[i]..max[i] 当上下界。
 *
 * @param {AudioBuffer} buffer
 * @param {number} buckets 桶数（一般取画布像素宽度的 1~2 倍）
 * @returns {{min: Float32Array, max: Float32Array, buckets: number}}
 */
export function computePeaks(buffer, buckets = 1200) {
  const n = Math.max(1, Math.floor(buckets));
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / n));
  const min = new Float32Array(n);
  const max = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const start = i * per;
    const end = i === n - 1 ? data.length : Math.min(start + per, data.length);
    let lo = 0;
    let hi = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, buckets: n };
}

/** 把某个声道降采样成单声道 Float32（等距抽样，够用于包络分析） */
function downsampleMono(buffer, targetRate) {
  const src = buffer.getChannelData(0);
  const ratio = buffer.sampleRate / targetRate;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // 桶内取平均，抑制混叠带来的假 onset
    const start = Math.floor(i * ratio);
    const end = Math.min(src.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += src[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/**
 * onset strength 包络：短时能量的正向差分。
 * 简单的能量法对 jubeat 这种鼓点清晰的曲目已经够用，而且比频谱通量快得多。
 */
function onsetEnvelope(samples) {
  const frames = Math.max(1, Math.floor(samples.length / ONSET_HOP));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * ONSET_HOP;
    const end = Math.min(samples.length, start + ONSET_HOP);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    energy[f] = Math.sqrt(sum / Math.max(1, end - start));
  }

  // 正向差分 + 半波整流：只保留「能量突然变强」的时刻
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  // 去均值 + 归一化，让自相关不受整体响度影响
  let mean = 0;
  for (let i = 0; i < frames; i++) mean += onset[i];
  mean /= frames || 1;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    onset[i] = Math.max(0, onset[i] - mean);
    if (onset[i] > peak) peak = onset[i];
  }
  if (peak > 0) for (let i = 0; i < frames; i++) onset[i] /= peak;
  return { onset, frames, frameRate: ANALYSIS_RATE / ONSET_HOP };
}

/** 在 lag 附近做抛物线插值，拿到亚帧精度的峰值位置 */
function refinePeak(ac, lag) {
  if (lag <= 0 || lag >= ac.length - 1) return lag;
  const y0 = ac[lag - 1];
  const y1 = ac[lag];
  const y2 = ac[lag + 1];
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-12) return lag;
  const delta = (0.5 * (y0 - y2)) / denom;
  return lag + Math.max(-1, Math.min(1, delta));
}

/**
 * 从 onset 包络估计 tempo：自相关找主周期，再定第一拍相位。
 * @param {Float32Array} onset
 * @param {number} frameRate 每秒多少帧
 */
function tempoFromOnset(onset, frameRate) {
  const n = onset.length;
  if (n < 8) return null;

  // 自相关（只算正 lag，且截断到 BPM_MIN 对应的最长周期）
  const minLag = Math.max(1, Math.floor((60 / BPM_MAX) * frameRate));
  const maxLag = Math.min(n - 1, Math.ceil((60 / BPM_MIN) * frameRate));
  if (maxLag <= minLag) return null;

  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += onset[i] * onset[i - lag];
    ac[lag] = sum / (n - lag);
  }

  // 找全局最大，同时收集备选（用于判断是不是倍/半速歧义）
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (ac[lag] > bestVal) {
      bestVal = ac[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestVal <= 0) return null;

  // 半速/倍速校验：若 2×lag 的自相关接近主峰，说明真实周期可能是它的一半
  // （自相关在周期的整数倍上都会出峰，取最小的那个更接近真实 beat）
  const half = Math.round(bestLag / 2);
  if (half >= minLag && ac[half] > bestVal * 0.85) bestLag = half;

  const refinedLag = refinePeak(ac, bestLag);
  const bpm = (60 * frameRate) / refinedLag;

  // 相位：在 [0, lag) 里找一个相位 θ，使 Σ onset[θ + k*lag] 最大 —— 那就是第一拍的位置
  const period = Math.round(refinedLag);
  let bestPhase = 0;
  let bestPhaseVal = -Infinity;
  const phaseLimit = Math.max(1, Math.min(period, n));
  for (let phase = 0; phase < phaseLimit; phase++) {
    let sum = 0;
    let count = 0;
    for (let i = phase; i < n; i += period) {
      sum += onset[i];
      count++;
    }
    const avg = count ? sum / count : 0;
    if (avg > bestPhaseVal) {
      bestPhaseVal = avg;
      bestPhase = phase;
    }
  }

  // 置信度：主峰强度相对包络总能量的比例，粗略但够用来提示「检测是否可信」
  let energySum = 0;
  for (let i = 0; i < n; i++) energySum += onset[i] * onset[i];
  const confidence = energySum > 0 ? Math.max(0, Math.min(1, bestVal / (energySum / n) / 8)) : 0;

  return {
    bpm,
    periodSeconds: refinedLag / frameRate,
    offset: bestPhase / frameRate,
    confidence,
    ac,
    minLag,
    maxLag,
    frameRate,
    bestLag: refinedLag,
  };
}

/**
 * 已知 BPM 时，只求第一拍相位（偏移）。
 *
 * 相位搜索在 [0, period) 内做，period 取 `60/bpm` 的整数帧数。为了让
 * 「拍点落在 onset 峰值上」更稳，同时评估 2 分拍/4 分拍（period/2、period/4）
 * 的相位候选，取归一化得分最高者，但**返回的 bpm 始终是锚点值**。
 *
 * @param {Float32Array} onset
 * @param {number} frameRate
 * @param {number} bpm 锚定 BPM
 * @returns {{offset:number, confidence:number, candidates:Array}|null}
 */
function phaseFromOnset(onset, frameRate, bpm) {
  const n = onset.length;
  if (n < 8) return null;

  const period = Math.max(1, Math.round((60 / bpm) * frameRate));
  if (period > n) return null;

  let energySum = 0;
  for (let i = 0; i < n; i++) energySum += onset[i] * onset[i];
  if (energySum <= 0) return null;
  const meanSq = energySum / n;

  // 对 candidate 周期（整拍/半拍/四分之一拍）各自找最佳相位，再比总分
  const candidates = [];
  let best = null;
  for (const divisor of [1, 2, 4]) {
    const p = Math.max(1, Math.round(period / divisor));
    let bestPhase = -1;
    let bestVal = -Infinity;
    for (let phase = 0; phase < p; phase++) {
      let sum = 0;
      let count = 0;
      for (let i = phase; i < n; i += p) {
        sum += onset[i];
        count++;
      }
      const avg = count ? sum / count : 0;
      if (avg > bestVal) {
        bestVal = avg;
        bestPhase = phase;
      }
    }
    if (bestPhase < 0) continue;
    // 归一化：与包络均方比较，得分越高说明拍点越贴合 onset 峰
    const score = bestVal / Math.sqrt(meanSq + 1e-12);
    const cand = {
      offset: bestPhase / frameRate,
      score,
      divisor,
      periodFrames: p,
    };
    candidates.push(cand);
    if (!best || score > best.score) best = cand;
  }
  if (!best) return null;

  // 略微精细化：在最佳相位邻域按半帧步进，找更贴合的位置
  const p = best.periodFrames;
  let refined = best.offset;
  let bestVal = -Infinity;
  for (let k = -2; k <= 2; k++) {
    const phase = best.offset * frameRate + k * 0.5;
    if (phase < 0 || phase >= p) continue;
    let sum = 0;
    let count = 0;
    for (let i = phase; i < n; i += p) {
      const i0 = Math.floor(i);
      const frac = i - i0;
      const v = onset[i0] * (1 - frac) + (onset[Math.min(i0 + 1, n - 1)] || 0) * frac;
      sum += v;
      count++;
    }
    const avg = count ? sum / count : 0;
    if (avg > bestVal) {
      bestVal = avg;
      refined = phase / frameRate;
    }
  }

  const confidence = Math.max(0, Math.min(1, best.score / 8));
  return { offset: refined, confidence, candidates };
}

/**
 * 检测 tempo。
 *
 * 两种模式：
 *   1) 有锚点（谱面自带 BPM）：**以锚点为准**，音频只用来求第一拍相位。
 *      谱面的 BPM 是权威值，音频自相关容易出倍速/半速歧义（实测常把 140+
 *      的曲子测成 70），所以只在锚点附近的窄带里做相位搜索，
 *      既拿到对齐信息，又不会把 BPM 带偏。
 *   2) 无锚点：退回自相关全量搜索（旧行为）。
 *
 * @param {AudioBuffer} buffer
 * @param {{maxSeconds?:number, bpm?:number|null}} [opts]
 *   maxSeconds 只分析前 N 秒（默认 90s，长曲子没必要全算）；
 *   bpm 为谱面锚定 BPM，给定时以它为准。
 * @returns {{bpm:number, offset:number, confidence:number, candidates:Array, anchored:boolean, analysis:{...}}|null}
 */
export function detectTempo(buffer, { maxSeconds = 90, bpm: anchorBpm = null } = {}) {
  const seconds = Math.min(buffer.duration, maxSeconds);
  if (seconds < 1) return null;

  // 只截取开头一段做分析：auto correlation 是 O(n²)，全曲会明显卡顿
  const src = buffer.getChannelData(0);
  const frames = Math.floor(seconds * buffer.sampleRate);
  const slice = {
    sampleRate: buffer.sampleRate,
    length: frames,
    duration: seconds,
    getChannelData: () => src.subarray(0, frames),
  };

  const mono = downsampleMono(slice, ANALYSIS_RATE);
  const { onset, frameRate } = onsetEnvelope(mono);

  // ── 有锚点：BPM 用谱面值，只搜相位 ──────────────────────────────
  if (Number.isFinite(anchorBpm) && anchorBpm > 0) {
    const anchored = phaseFromOnset(onset, frameRate, anchorBpm);
    if (anchored) {
      return {
        bpm: anchorBpm,
        offset: anchored.offset,
        confidence: anchored.confidence,
        anchored: true,
        candidates: anchored.candidates,
        analysis: {
          periodSeconds: 60 / anchorBpm,
          frameRate,
          analyzedSeconds: seconds,
          anchorBpm,
        },
      };
    }
    // 相位搜不出来（包络太空）也仍然返回锚点 BPM，偏移置 0
    return {
      bpm: anchorBpm,
      offset: 0,
      confidence: 0,
      anchored: true,
      candidates: [],
      analysis: { periodSeconds: 60 / anchorBpm, frameRate, analyzedSeconds: seconds, anchorBpm },
    };
  }

  // ── 无锚点：旧行为，自相关全量搜索 ─────────────────────────────
  const res = tempoFromOnset(onset, frameRate);
  if (!res) return null;

  // 备选：主周期附近的次峰，用于展示「可能是 X 或 Y BPM」
  const candidates = [];
  for (let lag = res.minLag; lag <= res.maxLag; lag++) {
    const v = res.ac[lag];
    if (
      v > res.ac[lag - 1] &&
      v >= res.ac[lag + 1] &&
      Math.abs(lag - res.bestLag) > res.bestLag * 0.08
    ) {
      candidates.push({ bpm: (60 * res.frameRate) / lag, strength: v });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);

  return {
    bpm: res.bpm,
    offset: res.offset,
    confidence: res.confidence,
    candidates: candidates.slice(0, 4),
    analysis: {
      periodSeconds: res.periodSeconds,
      frameRate: res.frameRate,
      analyzedSeconds: seconds,
    },
  };
}

/**
 * 按 BPM 生成节拍时间点（供打点音/节拍线用）。
 *
 * @param {{bpm:number, offset:number}} tempo
 * @param {number} duration
 * @param {{from?:number, limit?:number}} [opts]
 * @returns {number[]}
 */
export function beatTimes(tempo, duration, { from = 0, limit = 2000 } = {}) {
  const out = [];
  if (!tempo || !tempo.bpm) return out;
  const step = 60 / tempo.bpm;
  if (!(step > 0)) return out;
  let t = tempo.offset;
  while (t > from) t -= step; // 回退到 from 之前
  for (; t <= duration && out.length < limit; t += step) {
    if (t >= from) out.push(t);
  }
  return out;
}

/**
 * 采样级时钟播放器：AudioBufferSourceNode + GainNode。
 *
 * 与 <audio> 的区别：
 *   · 播放位置由 ctx.currentTime 推算，不受主线程调度抖动影响
 *   · 支持无缝 seek / 变速（playbackRate，变速同时变调，符合「对谱」用途）
 *   · 结束回调可靠
 */
export class AudioClockPlayer {
  /**
   * @param {AudioBuffer} buffer
   * @param {{onEnded?:Function, gain?:number}} [opts]
   */
  constructor(buffer, { onEnded = null, gain = 1 } = {}) {
    this.ctx = audioContext();
    this.buffer = buffer;
    this.duration = buffer.duration;
    this.onEnded = onEnded;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = gain;

    this.source = null;
    /** 播放起点（ctx 时间轴） */
    this.startedAtCtx = 0;
    /** 本次播放从音频的哪一秒开始 */
    this.startedFrom = 0;
    this.playing = false;
    /** 暂停/停止时保留的位置 */
    this.pausedAt = 0;
    this.rate = 1;
    this._disposed = false;
  }

  /** 当前播放位置（秒） */
  get currentTime() {
    if (!this.playing) return this.pausedAt;
    const elapsed = (this.ctx.currentTime - this.startedAtCtx) * this.rate;
    return Math.min(this.duration, this.startedFrom + elapsed);
  }

  /** 是否已到结尾 */
  get ended() {
    return this.currentTime >= this.duration - 1e-3;
  }

  /** 从指定位置开始播放 */
  play(from = null) {
    if (this._disposed) return;
    const start = from == null ? (this.ended ? 0 : this.pausedAt) : from;
    this.stopSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);

    src.onended = () => {
      // 只有「自然播完」才触发；被 stop() 打断时 playing 已置 false
      if (this.source !== src) return;
      this.playing = false;
      this.pausedAt = this.duration;
      this.source = null;
      this.onEnded?.();
    };

    this.source = src;
    this.startedAtCtx = this.ctx.currentTime;
    this.startedFrom = start;
    this.playing = true;
    src.start(0, Math.max(0, Math.min(start, this.duration)));
  }

  /** 暂停（保留位置） */
  pause() {
    if (!this.playing) return;
    const at = this.currentTime;
    this.stopSource();
    this.playing = false;
    this.pausedAt = at;
  }

  /** 跳到指定秒 */
  seek(seconds) {
    const t = Math.max(0, Math.min(this.duration, seconds));
    if (this.playing) {
      this.play(t);
    } else {
      this.pausedAt = t;
    }
  }

  /** 变速：播放中会从当前位置无缝切换 */
  setRate(rate) {
    const r = Math.max(0.25, Math.min(4, rate));
    if (r === this.rate) return;
    const at = this.currentTime;
    this.rate = r;
    if (this.playing) {
      this.play(at);
    }
  }

  /** 音量 0~1 */
  setGain(value) {
    this.gainNode.gain.value = Math.max(0, Math.min(1, value));
  }

  stopSource() {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {
      /* 已停止 */
    }
    try {
      this.source.disconnect();
    } catch {
      /* 忽略 */
    }
    this.source = null;
  }

  /** 彻底释放 */
  dispose() {
    this._disposed = true;
    this.stopSource();
    try {
      this.gainNode.disconnect();
    } catch {
      /* 忽略 */
    }
    this.playing = false;
    this.pausedAt = 0;
  }
}

/**
 * 解析结果缓存：key = `${bpm 锚点 ?? '-'}|${字节长度}|${首尾各 8 字节的十六进制}`。
 *
 * 为什么用内容指纹而不是对象引用：音频字节来自 chart-source 的模块级缓存，
 * 同一首歌的多个难度拿到的是**同一个 Uint8Array**，但 decodeAudio 后的
 * AudioBuffer / 峰值 / 相位是这个页面上最贵的一次计算（1.9 MB ogg 解码 + 1200 桶波形）。
 * 三难度各算一遍纯属浪费，所以按内容去重。
 *
 * 只缓存「字节 + bpm 锚点」都相同的解析结果。bpm 必须进 key：
 * detectTempo 在锚定模式下返回的 bpm/offset 直接取决于它。
 *
 * @type {Map<string, Promise<object>>}
 */
const analysisCache = new Map();

/** 内容指纹：长度 + 首尾字节，足以区分不同曲目而又不必哈希整个 1.9 MB */
function fingerprint(bytes, bpm) {
  const n = bytes.length;
  const head = Array.from(bytes.subarray(0, Math.min(8, n))).join(',');
  const tail = Array.from(bytes.subarray(Math.max(0, n - 8))).join(',');
  return `${bpm ?? '-'}|${n}|${head}|${tail}`;
}

/** 清空解析缓存（音频换源或需要强制重算时用） */
export function clearAnalysisCache() {
  analysisCache.clear();
}

/**
 * 一次性把音频解析到「可画、可播、可量」的状态。
 *
 * 结果按（音频内容 + bpm 锚点）缓存：页面上一首歌最多三个难度预览器，
 * 它们共用同一份音频，解析结果也应当共用 —— 否则三次 1.9 MB ogg 解码
 * 会把主线程占满好几秒，看起来就像「加载很慢」。
 *
 * @param {Uint8Array} bytes bgm 原始字节
 * @param {{buckets?:number, maxSeconds?:number, bpm?:number|null}} [opts]
 *   bpm 为谱面锚定 BPM：给了就以它为准，音频只用来求首拍相位。
 */
export async function analyzeAudio(bytes, { buckets = 1200, maxSeconds = 90, bpm = null } = {}) {
  const key = fingerprint(bytes, bpm);
  if (analysisCache.has(key)) return analysisCache.get(key);

  const p = (async () => {
    const buffer = await decodeAudio(bytes);
    const info = describeBuffer(buffer);
    const peaks = computePeaks(buffer, buckets);
    let tempo = null;
    try {
      tempo = detectTempo(buffer, { maxSeconds, bpm });
    } catch {
      tempo = null;
    }
    return { buffer, info, peaks, tempo };
  })();

  analysisCache.set(key, p);
  // 失败不要留下坏缓存，否则后续重试会一直拿到同一个 rejected promise
  p.catch(() => analysisCache.delete(key));
  return p;
}
