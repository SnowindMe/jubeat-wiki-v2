// jubeat memo 谱面解析器
// 规范见 docs/MEMO-FORMAT.md
//
// 核心语义：
//   每行 = [铺面 4 格] [|节奏谱|]
//   - 铺面：4x4 面板的一行；每 4 行 = 一个 4x4 快照
//   - 节奏谱：变长时间轴，每个符号 = 一个十六分单位，－ = 空单位
//   - 铺面与节奏谱里的带圈数字 = 时刻组编号，两边靠编号互相引用
//   - 一个组号占多格 = 同时押
//   - 键号 = (行-1)*4 + 列  (1-based, jubeat 标准 1..16)
//
// HOLD（长押）语义见 §6：
//   - 起点 = 带链接的数字（tap）
//   - 三角形（＜ ＞ ∨ ∧）指示尾部；尖角指向起点，播放时朝起点收拢
//   - **起点在哪，终点也就在哪**：同一个键上，起点之后的下一个 tap 即终点

/** 空位：COSMOS 用 口(U+53E3)，SONICY 用 □(U+25A1)，还有 ・ 等变体 */
const BLANK_RE = /[\u53e3\u25a1\u30fb.·]/;

/** hold 标记：占一个格子位，须替换成空位以保持 4 格对齐（不可删除！）
 *  实测全库出现的 5 种：∨ ∧ ＜ ＞ ┼，以及延伸线 ― ｜ | */
const HOLD_MARK_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/g;

/** 三角形标记（hold 尾部指示） */
const HOLD_TAIL_RE = /[\u2228\u2227\uFF1C\uFF1E]/;

/** 所有 hold 相关符号（含延伸线） */
export const HOLD_SYMBOL_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/;

/** 节奏谱空槽 */
export const AXIS_BLANK_RE = /[\uFF0D\u2015\u2014\u30FC-]/;

/** 节奏谱允许出现的字符 */
const AXIS_CHAR_RE = /[\u2460-\u2473\u3251-\u325f\uFF0D\u2015\u2014\u30FC\u2500]/;

/** 带圈数字 -> 序号 */
export function circledToIndex(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1; // ①..⑳
  if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21; // ㉑..㉟
  return null;
}

/** 序号 -> 带圈数字 */
export function indexToCircled(n) {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  return String(n);
}

/** 规范化整段 memo 文本 */
export function normalizeMemoText(text) {
  return text
    .replace(/\u53e3/g, '\u25a1')
    .replace(/\uFF5C/g, '|')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * 把一行拆成 [铺面, 节奏谱]。
 *
 * 难点：铺面里也含 |（hold 延伸线），例如原文 "|④□|"，其 ④ 是音符。
 * 做法：从**行尾**找最后一个 | 作为节奏谱右界，往左扫，遇到非节奏谱字符即分界。
 */
export function splitGridAxis(line) {
  const chars = [...line];
  const last = chars.length - 1;
  if (last < 0) return null;
  const whole = () => ({ grid: line.trim(), axis: null });
  if (chars[last] !== '|') return whole();

  let i = last - 1;
  let sawAxis = false;
  while (i >= 0) {
    const c = chars[i];
    if (c === '|') {
      if (!sawAxis) return whole();
      return { grid: chars.slice(0, i).join('').trim(), axis: chars.slice(i + 1, last).join('') };
    }
    if (AXIS_CHAR_RE.test(c) || c === '\uFF5C') { sawAxis = true; i--; continue; }
    if (c === ' ' || c === '\u3000') { i--; continue; }
    return whole();
  }
  return whole();
}

/**
 * 解析 memo 文本。
 * @param {string} text memo 文本
 * @param {object} [opts]
 * @param {number|null} [opts.bpm]
 * @param {Array<{measure:number,row:number,col:number}>} [opts.holdStarts]
 *        hold 起点位置。该信息只存在于 atwiki 页面的超链接里，纯文本拿不到，
 *        由抓取器写入 JSON（见 scripts/fetch-memo.mjs）。
 */
export function parseMemo(text, { bpm = null, holdStarts = null } = {}) {
  const startSet = new Set();
  if (holdStarts) for (const h of holdStarts) startSet.add(`${h.measure}:${h.row}:${h.col}`);
  return build(text, startSet);
}

function build(text, startSet) {
  const lines = normalizeMemoText(text).split('\n');
  const measures = [];
  const unparsedLines = [];
  let cur = null;
  let holdMarkCount = 0;

  // 解析一行铺面：hold 标记替换成空位（保持 4 格对齐），并保留每格标记
  const parseGrid = (cellText) => {
    if (!cellText) return null;
    const marks = [null, null, null, null];
    let clean = '';
    let col = -1;
    for (const ch of cellText) {
      if (HOLD_MARK_RE.test(ch)) {
        col++;
        if (col < 4) marks[col] = ch;
        clean += '\u25a1';
        holdMarkCount++;
        continue;
      }
      if (ch === ' ' || ch === '\u3000') continue;
      col++;
      clean += ch;
    }
    const chars = [...clean];
    if (chars.length !== 4) {
      if (chars.length < 4 && chars.every((c) => BLANK_RE.test(c))) {
        while (chars.length < 4) chars.push('\u25a1');
      } else {
        return null;
      }
    }
    return { grid: chars, marks };
  };

  const finish = () => { if (cur) measures.push(cur); };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,4}$/.test(line)) {
      finish();
      cur = { no: parseInt(line, 10), rows: [] };
      continue;
    }
    if (!cur) continue;

    const split = splitGridAxis(line);
    const parsed = parseGrid(split.grid);
    if (parsed) {
      const axis = split.axis;
      const starts = [false, false, false, false];
      parsed.grid.forEach((ch, col) => {
        if (circledToIndex(ch) != null && startSet.has(`${cur.no}:${cur.rows.length}:${col}`)) {
          starts[col] = true;
        }
      });
      cur.rows.push({
        grid: parsed.grid,
        marks: parsed.marks,
        starts,
        axisRaw: axis,
        slots: axis ? [...axis] : null,
      });
      continue;
    }
    unparsedLines.push(line);
  }
  finish();

  // 时间轴升序：小节 -> 槽位 -> 组号
  const notes = [];

  for (const ms of measures) {
    const slotsTotal = ms.rows.reduce((a, r) => a + (r.slots ? r.slots.length : 0), 0);
    const slotCount = slotsTotal || 16;

    // 节奏谱：组号 -> 槽位
    const slotOfGroup = new Map();
    let linear = 0;
    for (const r of ms.rows) {
      if (!r.slots) continue;
      r.slots.forEach((ch, i) => {
        if (AXIS_BLANK_RE.test(ch)) return;
        const n = circledToIndex(ch);
        if (n == null) return;
        if (!slotOfGroup.has(n)) slotOfGroup.set(n, []);
        slotOfGroup.get(n).push(linear + i);
      });
      linear += r.slots.length;
    }

    // 铺面：组号 -> 键位
    const keysOfGroup = new Map();
    ms.rows.forEach((r, rowIdx) => {
      const snap = Math.floor(rowIdx / 4);
      const rowInSnap = rowIdx % 4;
      r.grid.forEach((ch, col) => {
        const n = circledToIndex(ch);
        if (n == null) return;
        if (!keysOfGroup.has(n)) keysOfGroup.set(n, []);
        keysOfGroup.get(n).push({
          key: rowInSnap * 4 + col + 1,
          snapshot: snap,
          row: rowInSnap,
          col,
          rawRow: rowIdx,
        });
      });
    });

    // ---- hold 起点识别（纯文本即可，不依赖额外标记）----
    // 规则：三角（┼ ∧ ∨ ＜ ＞）与某个数字**同列相邻**时，该数字就是 hold 起点。
    // 三角在起点下方 => 向下延伸；在上方 => 向上延伸（都朝起点收拢）。
    ms.rows.forEach((r, rowIdx) => {
      (r.marks || []).forEach((mk, col) => {
        if (!mk || !HOLD_TAIL_RE.test(mk)) return;
        let best = null;
        for (let k = 0; k < ms.rows.length; k++) {
          const ch = ms.rows[k].grid[col];
          if (circledToIndex(ch) == null) continue;
          const dist = Math.abs(k - rowIdx);
          if (!best || dist < best.dist) best = { row: k, dist };
        }
        if (!best) return;
        const target = ms.rows[best.row];
        if (!target.holdStartCols) target.holdStartCols = new Set();
        target.holdStartCols.add(col);
      });
    });

    const groupIds = [...keysOfGroup.keys()].sort((a, b) => a - b);
    for (const g of groupIds) {
      const cells = keysOfGroup.get(g);
      const slots = slotOfGroup.get(g) || [];
      notes.push({
        measure: ms.no,
        group: g,
        slot: slots.length ? slots[0] : null,
        slotCount,
        keys: cells.map((c) => c.key).sort((a, b) => a - b),
        cells,
        // 本组中哪些键是长押起点（由三角标记推导）
        holdStartKeys: cells
          .filter((c) => ms.rows[c.rawRow]?.holdStartCols?.has(c.col))
          .map((c) => c.key),
      });
    }

    ms.snapshots = Math.ceil(ms.rows.length / 4);
    ms.slotCount = slotCount;
  }

  // ---- hold 配对：起点在哪，终点也就在哪 ----
  // 同一按键位置上，起点 tap 之后的下一个 tap 即该长押的终点。
  // 因此按 key 把全部 tap 串起来，相邻两个构成一段长押。
  const tapsByKey = new Map();
  for (const n of notes) {
    for (const c of n.cells) {
      if (!tapsByKey.has(c.key)) tapsByKey.set(c.key, []);
      tapsByKey.get(c.key).push({ measure: n.measure, slot: n.slot, group: n.group, key: c.key, note: n });
    }
  }
  let holdCount = 0;
  const holds = [];
  for (const [key, list] of tapsByKey) {
    // 按时间排序（小节 -> 槽位）
    list.sort((a, b) => a.measure - b.measure || (a.slot ?? 0) - (b.slot ?? 0));
    for (let i = 0; i < list.length - 1; i++) {
      const from = list[i];
      const isStart = from.note.holdStartKeys.includes(key);
      if (!isStart) continue;
      const to = list[i + 1];
      holdCount++;
      holds.push({
        key,
        fromMeasure: from.measure,
        fromSlot: from.slot,
        fromGroup: from.group,
        toMeasure: to.measure,
        toSlot: to.slot,
        toGroup: to.group,
      });
      // 标记在音符上，供播放器渲染
      from.note.holds = from.note.holds || [];
      from.note.holds.push({ key, toMeasure: to.measure, toSlot: to.slot });
    }
  }

  notes.sort((a, b) => (a.measure - b.measure) || ((a.slot ?? 0) - (b.slot ?? 0)) || (a.group - b.group));

  return {
    measures,
    notes,
    holds,
    stats: {
      measureCount: measures.length,
      noteCount: notes.reduce((a, n) => a + n.keys.length, 0),
      groupCount: notes.length,
      holdCount,
      holdMarkCount,
      unparsedLines,
    },
  };
}

/** 便捷：只要音符数（用于抓取校验） */
export function countNotes(text) {
  return parseMemo(text).stats.noteCount;
}

/**
 * 转换为时间轴（秒），供播放器使用。
 * 等分小节模型：一小节 = slotCount 个十六分单位 = beatsPerMeasure 拍。
 */
export function toTimeline(parsed, { bpm, beatsPerMeasure = 4 } = {}) {
  if (!bpm) throw new Error('toTimeline 需要 bpm');
  const secPerBeat = 60 / bpm;
  const measureStart = new Map();
  let t = 0;
  for (const ms of parsed.measures) {
    measureStart.set(ms.no, t);
    t += secPerBeat * beatsPerMeasure;
  }
  const timeAt = (measure, slot, slotCount) => {
    const base = measureStart.get(measure) ?? 0;
    const unit = (secPerBeat * beatsPerMeasure) / (slotCount || 16);
    return base + (slot ?? 0) * unit;
  };

  const events = [];
  for (const n of parsed.notes) {
    if (n.slot == null) continue;
    events.push({ ...n, time: timeAt(n.measure, n.slot, n.slotCount) });
  }
  events.sort((a, b) => a.time - b.time);

  // hold 区间：起点时间 -> 终点时间
  const holdSpans = (parsed.holds || []).map((h) => {
    const fromNote = parsed.notes.find((n) => n.measure === h.fromMeasure && n.group === h.fromGroup);
    const toNote = parsed.notes.find((n) => n.measure === h.toMeasure && n.group === h.toGroup);
    return {
      key: h.key,
      start: timeAt(h.fromMeasure, h.fromSlot, fromNote?.slotCount),
      end: timeAt(h.toMeasure, h.toSlot, toNote?.slotCount),
    };
  });

  return { events, holdSpans, duration: t };
}
