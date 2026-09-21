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

/** 空位：COSMOS 用 口(U+53E3)，SONICY 用 □(U+25A1)，还有 ・ 等变体 */
const BLANK_RE = /[\u53e3\u25a1\u30fb.·]/;

/** hold 标记：占一个格子位，须替换成空位以保持 4 格对齐（不可删除！） */
const HOLD_MARK_RE = /[\u2228\u2227\uFF1C\uFF1E\u2015\uFF5C|]/g; // ∨ ∧ ＜ ＞ ― ｜ |

/** 节奏谱空槽 */
const AXIS_BLANK_RE = /[\uFF0D\u2015\u2014\u30FC-]/; // － ― — ー -

/** 带圈数字 -> 序号 */
export function circledToIndex(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1; // ①..⑳
  if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21; // ㉑..㉟
  return null;
}

/** 序号 -> 带圈数字（用于回写/调试） */
export function indexToCircled(n) {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  return String(n);
}

/** 规范化整段 memo 文本（统一空位符，去掉行尾空白） */
export function normalizeMemoText(text) {
  return text
    .replace(/\u53e3/g, '\u25a1') // 口 -> □
    .replace(/\uFF5C/g, '|')       // ｜ -> |
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * 解析 memo 文本。
 * @returns {{measures: Array, notes: Array, stats: Object}}
 *   measures: [{ no, rows:[{grid,axisRaw,slots}], snapshots }]
 *   notes:    [{ time, measure, slot, keys:[1..16], group }]
 *   stats:    { measureCount, noteCount, holdMarkCount, unparsedLines }
 */
export function parseMemo(text, { bpm = null } = {}) {
  const lines = normalizeMemoText(text).split('\n');
  const measures = [];
  const unparsedLines = [];
  let cur = null;
  let holdMarkCount = 0; // 必须在 this_grid 使用前初始化（TDZ）

  // 解析一行铺面：hold 标记替换成空位（保持 4 格对齐），返回归一化后的 4 格
  const this_grid = (cellText) => {
    if (!cellText) return null;
    let clean = cellText.replace(HOLD_MARK_RE, () => {
      holdMarkCount++;
      return '\u25a1';
    });
    clean = clean.replace(/[\s\u3000]/g, '');
    let chars = [...clean];
    if (chars.length !== 4) {
      // 整行都是 hold 延伸线（原文如 "|□□|"）时，去掉标记后会短于 4 格。
      // 这类行不携带音符，按「空铺面行」处理并补足 4 格，而不是丢弃
      // —— 丢弃会造成后续行错位，进而漏算音符。
      if (chars.length > 0 && chars.length < 4 && chars.every((c) => BLANK_RE.test(c))) {
        chars = [...Array(4)].map(() => '\u25a1');
      } else {
        return null;
      }
    }
    return { grid: chars };
  };

  const finish = () => { if (cur) { if (cur.rows.length || cur.no) measures.push(cur); } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 小节号：独占一行的纯数字
    if (/^\d{1,4}$/.test(line)) {
      finish();
      cur = { no: parseInt(line, 10), rows: [] };
      continue;
    }
    if (!cur) continue;

    // 主形态：[铺面] |节奏谱|
    const m = line.match(/^(.*?)\s*\|([^|]*)\|\s*$/);
    if (m) {
      const gridCell = m[1];
      const axisRaw = m[2];
      // 铺面侧为空（原文形如 "|□□|"，两侧 | 都是 hold 延伸线）-> 记为一行空铺面
      if (!gridCell.replace(/[\s\u3000]/g, '')) {
        holdMarkCount += [...gridCell].filter((c) => HOLD_MARK_RE.test(c)).length;
        cur.rows.push({ grid: [...Array(4)].map(() => '\u25a1'), axisRaw, slots: [...axisRaw] });
        continue;
      }
      const parsed = this_grid(gridCell);
      if (parsed) {
        cur.rows.push({ grid: parsed.grid, axisRaw, slots: [...axisRaw] });
        continue;
      }
      unparsedLines.push(line);
      continue;
    }

    // 续行铺面（没有节奏谱）
    const parsed = this_grid(line);
    if (parsed) {
      cur.rows.push({ grid: parsed.grid, axisRaw: null, slots: null });
      continue;
    }
    unparsedLines.push(line);
  }
  finish();

  // ---- 展开为音符时间轴 ----
  const notes = [];
  for (const ms of measures) {
    // 速度 = 该小节节奏谱总槽数（16 为标准小节）
    const slotsTotal = ms.rows.reduce((a, r) => a + (r.slots ? r.slots.length : 0), 0);
    const slotCount = slotsTotal || 16;

    // 节奏谱：组号 -> 槽位（同一小节内）
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

    // 铺面：组号 -> 键号列表（跨快照）
    const keysOfGroup = new Map();
    ms.rows.forEach((r, rowIdx) => {
      const snap = Math.floor(rowIdx / 4);
      [...r.grid].forEach((ch, col) => {
        const n = circledToIndex(ch);
        if (n == null) return;
        if (!keysOfGroup.has(n)) keysOfGroup.set(n, []);
        keysOfGroup.get(n).push({
          key: (rowIdx % 4) * 4 + col + 1,
          snapshot: snap,
          row: rowIdx % 4,
          col,
        });
      });
    });

    // 合并：每个组号 = 一个音符组（同一时刻按下若干键）
    const groupIds = [...keysOfGroup.keys()].sort((a, b) => a - b);
    for (const g of groupIds) {
      const cells = keysOfGroup.get(g);
      const slots = slotOfGroup.get(g) || [];
      notes.push({
        measure: ms.no,
        group: g,
        slot: slots.length ? slots[0] : null, // 十六分位置（小节内线性）
        slotCount,
        keys: cells.map((c) => c.key).sort((a, b) => a - b),
        cells,
      });
    }

    ms.snapshots = Math.ceil(ms.rows.length / 4);
    ms.slotCount = slotCount;
  }

  // 时间升序（同小节内按 slot，跨小节按小节号）
  notes.sort((a, b) => (a.measure - b.measure) || ((a.slot ?? 0) - (b.slot ?? 0)) || (a.group - b.group));

  return {
    measures,
    notes,
    stats: {
      measureCount: measures.length,
      noteCount: notes.reduce((a, n) => a + n.keys.length, 0), // 音符（按键）数
      groupCount: notes.length,
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
 * 转换为「毫秒时间轴」，供播放器使用。
 * 采用等分小节模型：一小节 = slotCount 个十六分单位 = 4 拍。
 * @param {{bpm:number}} opts
 */
export function toTimeline(parsed, { bpm, beatsPerMeasure = 4 } = {}) {
  if (!bpm) throw new Error('toTimeline 需要 bpm');
  const secPerBeat = 60 / bpm;
  const events = [];
  // 每小节累计时长（支持变长度小节）
  let t = 0;
  let lastMeasure = parsed.measures[0]?.no ?? 1;
  const measureStart = new Map();
  for (const ms of parsed.measures) {
    measureStart.set(ms.no, t);
    t += secPerBeat * beatsPerMeasure;
  }
  for (const n of parsed.notes) {
    if (n.slot == null) continue;
    const base = measureStart.get(n.measure) ?? 0;
    const unit = (secPerBeat * beatsPerMeasure) / (n.slotCount || 16);
    events.push({
      ...n,
      time: base + n.slot * unit,
    });
  }
  events.sort((a, b) => a.time - b.time);
  return { events, duration: t };
}
