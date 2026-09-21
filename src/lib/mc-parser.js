// Malody .mc 谱面解析器（jubeat 模式，mode=4）
//
// .mcz 是关键数据源：本质是 zip，内含
//   0/<曲名>_<难度> Lv<等级>.mc   谱面 JSON（几十 KB）
//   0/bgm.ogg                     音频（占 95% 体积，不需要）
//   0/jkt_*.png                   曲绘（不需要）
//
// .mc 结构（Malody 格式）：
//   meta.song.title/artist, meta.version("EXT Lv9.7"), meta.level
//   time[]  = 变 BPM 列表 [{beat:[a,b,c], bpm}]
//   note[]  = 音符：
//       type=1            音频轨（跳过）
//       有 index          按键音符，index = jubeat 键位 1..16
//       有 endbeat/endindex  → 长押（起点 index、终点 endindex）
//
// beat 是分数表示 [分母, 分子, 每小节拍数]，实际拍位 = a + b/c

/** beat 数组 -> 浮点拍位 */
export function beatToNumber(beat) {
  if (!Array.isArray(beat) || beat.length < 2) return 0;
  const [a, b, c] = beat;
  if (!c) return a + b;
  return a + b / c;
}

/**
 * 解析单个 .mc 文本。
 * @param {string} text
 * @returns {{meta, bpms, notes, holds, stats}}
 */
export function parseMc(text) {
  const j = JSON.parse(text);
  const meta = j.meta || {};

  const bpms = (j.time || []).map((t) => ({ beat: beatToNumber(t.beat), bpm: t.bpm }));
  bpms.sort((a, b) => a.beat - b.beat);

  const notes = [];
  const holds = [];
  for (const n of j.note || []) {
    if (n.type === 1 || n.sound) continue; // 音频轨
    if (n.index == null) continue;
    const start = beatToNumber(n.beat);
    if (n.endbeat != null && n.endindex != null) {
      holds.push({
        key: n.index,
        startBeat: start,
        endBeat: beatToNumber(n.endbeat),
        endKey: n.endindex,
      });
    } else {
      notes.push({ key: n.index, beat: start });
    }
  }
  notes.sort((a, b) => a.beat - b.beat || a.key - b.key);
  holds.sort((a, b) => a.startBeat - b.startBeat);

  return {
    meta: {
      title: meta.song?.title ?? null,
      artist: meta.song?.artist ?? null,
      version: meta.version ?? null,
      level: meta.level ?? null,
      creator: meta.creator ?? null,
    },
    bpms,
    notes,
    holds,
    stats: {
      noteCount: notes.length + holds.length,
      holdCount: holds.length,
      tapCount: notes.length,
      bpmCount: bpms.length,
    },
  };
}

/** 从版本串（"EXT Lv9.7"）抽难度标记 */
export function diffFromVersion(version) {
  const m = String(version || '').match(/^\s*(BSC|ADV|EXT)/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 把 .mc 的拍位时间线转成秒。
 * @param {Array<{beat:number,bpm:number}>} bpms
 * @param {number} atBeat
 */
export function beatToSeconds(bpms, atBeat) {
  if (!bpms.length) return 0;
  let sec = 0;
  let cur = bpms[0];
  // 首个 bpm 之前的时间按第一个 bpm 计
  if (atBeat <= cur.beat) return (atBeat - cur.beat) * (60 / cur.bpm);
  for (let i = 1; i < bpms.length; i++) {
    const next = bpms[i];
    if (atBeat <= next.beat) {
      sec += (atBeat - cur.beat) * (60 / cur.bpm);
      return sec;
    }
    sec += (next.beat - cur.beat) * (60 / cur.bpm);
    cur = next;
  }
  sec += (atBeat - cur.beat) * (60 / cur.bpm);
  return sec;
}
