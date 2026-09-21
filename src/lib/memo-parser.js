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

/** hold 标记：占一个格子位，须替换成空位以保持 4 格对齐（不可删除！）
 *  实测全库出现的 5 种：∨ ∧ ＜ ＞ ┼，以及延伸线 ― ｜ |
 *  ┼(U+253C) 是十字延伸线，曾遗漏导致音符少算，勿删。 */
const HOLD_MARK_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/g; // ∨ ∧ ＜ ＞ ┼ ― ｜ |

/** 所有 hold 相关符号（含竖/横延伸线），用于统计与校验 */
export const HOLD_SYMBOL_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/;

/** 节奏谱空槽 */
export const AXIS_BLANK_RE = /[\uFF0D\u2015\u2014\u30FC-]/; // － ― — ー -

/** 节奏谱字符：带圈数字、－ 空槽、| 自身的边框 */
const AXIS_CHAR_RE = /[\u2460-\u2473\u3251-\u325f\uFF0D\u2015\u2014\u30FC\u2500]/;

/**
 * 把一行拆成 [铺面, 节奏谱]。
 *
 * 难点：铺面里也含 | （hold 延伸线），所以不能简单按 | 切。
 * 思路：从**行尾**倒着找到最后一个 | 作为节奏谱右界；
 *       再往左，只要字符属于「节奏谱值域」（带圈数字 / 空槽符 / ｜），就继续纳入，
 *       直到遇见不属于该值域、且不是边框的字符为止 —— 那里就是左右分界。
 *
 * 例：
 *   "□□□② |①－②－|"      -> grid="□□□②"  axis="①－②－"
 *   "|④□|"                -> grid="|④□|"   axis=null   （整行都是铺面，④ 是音符）
 *   "||□| |④－|"          -> grid="||□|"   axis="④－"
 */
export function splitGridAxis(line) {
  const chars = [...line];
  const last = chars.length - 1;
  if (last < 0) return null;
  const whole = () => ({ grid: line.trim(), axis: null });
  // 不以 | 结尾 => 整行都是铺面
  if (chars[last] !== '|') return whole();

  // 找配对的开头 |（节奏谱的左边框）：从右往左，跳过值域字符后遇到的第一个 |
  let i = last - 1;
  let sawAxisChar = false;
  while (i >= 0) {
    const c = chars[i];
    if (c === '|') {
      // 左边框。只有当前面已出现过节奏谱字符，才认定这是节奏谱；
      // 否则说明这个 | 也是铺面里的 hold 延伸线（如 "|④□|"）
      if (!sawAxisChar) return whole();
      return {
        grid: chars.slice(0, i).join('').trim(),
        axis: chars.slice(i + 1, last).join(''),
      };
    }
    if (AXIS_CHAR_RE.test(c) || c === '\uFF5C') { sawAxisChar = true; i--; continue; }
    if (c === ' ' || c === '\u3000') { i--; continue; }
    return whole();
  }
  return whole();
}

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
      // hold 延伸线占格，去掉/替换后可能不足 4 格（原文如 "|□□|"、"||□|"）。
      // 这类行不携带音符，按「空铺面行」补足 4 格保留 —— 丢弃会造成后续行错位、漏算音符。
      if (chars.length < 4 && chars.every((c) => BLANK_RE.test(c))) {
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
    // ⚠️ 铺面里也会出现 | （hold 延伸线），例如原文 "|④□|"，其 ④ 是**音符**。
    //    因此不能把 | 当分隔符先切分，否则会丢掉该音符（曾导致整库 2 首各少 1 音符）。
    //    做法：把整行按字符遍历，从行尾识别「真正的节奏谱」段。
    const split = splitGridAxis(line);
    if (split) {
      const parsed = this_grid(split.grid);
      if (parsed) {
        const axis = split.axis;
        cur.rows.push({ grid: parsed.grid, axisRaw: axis, slots: axis ? [...axis] : null });
        continue;
      }
      unparsedLines.push(line);
      continue;
    }

    // 续行铺面（无节奏谱）
    const parsedBare = this_grid(line);
    if (parsedBare) {
      cur.rows.push({ grid: parsedBare.grid, axisRaw: null, slots: null });
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
