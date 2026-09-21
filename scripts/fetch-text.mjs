// jubeat memo 抓取与解析（mywiki.cn 数据源）
//
// 设计（经用户确认）：
//   - memo 语义完全由**符号本身**承载：`①` 起点、`＜＞∨∧┼` 三角尾部、`｜―` 延伸线
//     → 不需要解析 HTML 结构、不需要红色标记、不需要超链接
//   - 长押坐标在抓取阶段就算好，写进 JSON 的 holds 数组
//
// 长押规则（用户逐条确认）：
//   1. 起点 = 三角指向的数字格
//      - 横向三角 `＜ ＞` → 起点在**同一行**（延伸线 `―` 可横跨整行，如 "①――＜"）
//      - 纵向三角 `∨ ∧ ┼` → 起点在**同一列**（延伸线 `｜` 纵向连接）
//   2. 终点 = **同一个键位**上，后续小节出现的下一个 tap；曲末找不到则视为延伸到曲末
//   3. `┼` = **两条长押交叉**，拆成纵、横各一条
//   4. 校验锚点：页面 "Notes: N (H)" 的 H = 长押条数
//
// 用法: node scripts/fetch-text.mjs "天空の華_(EXT)" [...]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'memo');
mkdirSync(OUT, { recursive: true });

const BASE = 'https://www.mywiki.cn/cosmosmemo/';

export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
}

export const HOLD_TAIL_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C]/;  // ∨ ∧ ＜ ＞ ┼
export const HOLD_LINE_RE = /[\u2015\uFF5C|]/;                    // ― ｜ |
export const CROSS = '\u253C';                                    // ┼

export const isCircle = (ch) => {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return c >= 0x2460 && c <= 0x2473;
};

/** 取页面纯文本 */
export async function fetchPageText(title) {
  const url = new URL(encodeURIComponent(title), BASE).href;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jubeat-wiki-builder/1.0' },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const m = html.match(/<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  let body = m ? m[1] : html;
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return { text: body, url };
}

/** 从纯文本切出 memo 区 */
export function sliceMemo(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const scoreRe = /^[^\s|]{0,8}\s*\|[^|]*\|/;
  const bareRe = /^[^\s|]{4}$/;
  const start = lines.findIndex((l) => /^\d{1,4}$/.test(l));
  if (start < 0) return null;

  const out = [];
  let blanks = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (/^\d{1,4}$/.test(l) || scoreRe.test(l) || bareRe.test(l)) { out.push(l); blanks = 0; continue; }
    if (l === '') { blanks++; if (blanks > 3) break; continue; }
    if (/^(不確定度|检索自|分类|BPM|Level|Notes)/.test(l)) { blanks = 0; continue; }
    break;
  }
  return out.join('\n');
}

/** 元信息：Notes: N (H) 的 H = 长押条数（校验锚点） */
export function parseMeta(text) {
  const notes = text.match(/Notes:\s*(\d+)\s*(?:\((\d+)\))?/);
  const bpm = text.match(/BPM:\s*([\d.\-]+)/);
  const level = text.match(/Level:\s*(\d+)/);
  return {
    declaredNotes: notes ? +notes[1] : null,
    declaredHolds: notes && notes[2] ? +notes[2] : null,
    bpm: bpm ? bpm[1] : null,
    level: level ? +level[1] : null,
  };
}

/** memo 纯文本 -> 小节数组（每行 4 格：数字或标记） */
export function parseGridText(memo) {
  const measures = [];
  let cur = null, rowIdx = 0;
  for (const raw of memo.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,4}$/.test(line)) { cur = { no: +line, rows: [] }; measures.push(cur); rowIdx = 0; continue; }
    if (!cur) continue;

    let gridText = line, axis = null;
    const bar = line.match(/^(.*?)\s*\|([^|]*)\|\s*$/);
    if (bar && bar[1].trim().length <= 8) { gridText = bar[1].trim(); axis = bar[2]; }

    const cells = Array.from({ length: 4 }, () => ({ ch: '\u25a1', mark: null }));
    let col = -1;
    for (const raw2 of gridText) {
      const ch = raw2 === '\u53e3' ? '\u25a1' : raw2;
      if (ch === ' ' || ch === '\u3000') continue;
      if (HOLD_TAIL_RE.test(ch) || HOLD_LINE_RE.test(ch)) {
        col++;
        if (col < 4) cells[col].mark = ch;
        continue;
      }
      col++;
      if (col < 4) cells[col].ch = ch;
    }
    cur.rows.push({ rowIdx: rowIdx++, cells, axis });
  }
  return measures;
}

/**
 * 计算长押坐标。
 * @returns {Array<{key,from:{measure,row,col},to:{measure,row,col},tail:{mark,row,col,side}}>}
 */
export function computeHolds(measures) {
  const keyOf = (rowIdx, col) => (rowIdx % 4) * 4 + col + 1;
  const lastMeasure = measures.length ? measures[measures.length - 1].no : 0;

  // 键位 -> tap 列表（按时间排序）
  const digitsByKey = new Map();
  for (const m of measures) {
    m.rows.forEach((r) => {
      r.cells.forEach((c, col) => {
        if (!isCircle(c.ch)) return;
        const k = keyOf(r.rowIdx, col);
        if (!digitsByKey.has(k)) digitsByKey.set(k, []);
        digitsByKey.get(k).push({ measure: m.no, row: r.rowIdx, col });
      });
    });
  }
  for (const list of digitsByKey.values()) list.sort((a, b) => a.measure - b.measure);

  /** 终点：同键位后续小节的第一个 tap；曲末找不到则延伸到曲末 */
  const endFor = (key, fromMeasure) => {
    const next = (digitsByKey.get(key) || []).find((d) => d.measure > fromMeasure);
    if (next) return { measure: next.measure, row: next.row, col: next.col };
    return { measure: lastMeasure + 1, row: null, col: null };
  };

  /**
   * 找三角指向的起点数字。
   * 横向三角（＜ ＞）优先同行；纵向三角（∨ ∧ ┼）优先同列。限定同一 4×4 快照内。
   */
  const findStart = (m, rowIdx, col, mark, { forceHorizontal = false, forceVertical = false } = {}) => {
    const snap = Math.floor(rowIdx / 4);
    const horizontal = forceHorizontal || (!forceVertical && /[\uFF1C\uFF1E]/.test(mark));
    const cands = [];
    for (const rr of m.rows) {
      if (Math.floor(rr.rowIdx / 4) !== snap) continue;
      rr.cells.forEach((cc, ccol) => {
        if (!isCircle(cc.ch)) return;
        const dRow = Math.abs(rr.rowIdx - rowIdx);
        const dCol = Math.abs(ccol - col);
        if (dRow === 0 && dCol === 0) return;
        const w = horizontal ? dRow * 10 + dCol : dCol * 10 + dRow;
        cands.push({ row: rr.rowIdx, col: ccol, w, ch: cc.ch });
      });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.w - b.w || a.col - b.col);
    return cands[0];
  };

  const holds = [];
  for (const m of measures) {
    for (const r of m.rows) {
      for (let col = 0; col < 4; col++) {
        const c = r.cells[col];
        if (!c.mark || !HOLD_TAIL_RE.test(c.mark)) continue;

        // 纵向那条
        const sV = findStart(m, r.rowIdx, col, c.mark, { forceVertical: c.mark === CROSS });
        if (sV) {
          const key = keyOf(sV.row, sV.col);
          holds.push({
            key,
            from: { measure: m.no, row: sV.row, col: sV.col },
            to: endFor(key, m.no),
            tail: { mark: c.mark, row: r.rowIdx, col, side: r.rowIdx < sV.row ? 'above' : 'below' },
          });
        }

        // `┼` = 两条长押交叉：再补一条横向的
        if (c.mark === CROSS) {
          const sH = findStart(m, r.rowIdx, col, c.mark, { forceHorizontal: true });
          if (sH) {
            const keyH = keyOf(sH.row, sH.col);
            holds.push({
              key: keyH,
              from: { measure: m.no, row: sH.row, col: sH.col },
              to: endFor(keyH, m.no),
              tail: { mark: c.mark, row: r.rowIdx, col, side: 'horizontal' },
            });
          }
        }
      }
    }
  }

  holds.sort((a, b) => a.from.measure - b.from.measure || a.from.row - b.from.row || a.from.col - b.from.col);
  return holds;
}

/** 一步到位：标题 -> 结构化谱面对象 */
export async function fetchChart(title) {
  const { text, url } = await fetchPageText(title);
  const meta = parseMeta(text);
  const memo = sliceMemo(text);
  if (!memo) return { ok: false, title, why: '未找到 memo 区' };

  const measures = parseGridText(memo);
  const holds = computeHolds(measures);
  const songName = title.replace(/\s*\([^)]*\)$/, '').trim();
  const diff = (title.match(/\(([^)]+)\)$/) || [])[1] || '';

  return {
    ok: true,
    title,
    fn: `${safeName(songName)}-${diff}-mywiki.json`,
    chart: {
      schema: 1,
      song: songName,
      difficulty: diff,
      source: 'cosmos-mywiki',
      url,
      bpm: meta.bpm,
      level: meta.level,
      declaredNotes: meta.declaredNotes,
      declaredHolds: meta.declaredHolds,
      measuredHolds: holds.length,
      measures: measures.map((m) => ({
        no: m.no,
        rows: m.rows.map((r) => ({
          grid: r.cells.map((x) => x.ch).join(''),
          axis: r.axis,
          hold: r.cells.map((x) => x.mark),
        })),
      })),
      holds,
    },
  };
}

// ---------- CLI ----------
const isMain = process.argv[1] && process.argv[1].endsWith('fetch-text.mjs');
const titles = isMain ? process.argv.slice(2) : [];

if (isMain && !titles.length) {
  console.log('用法: node scripts/fetch-text.mjs "天空の華_(EXT)" [...]');
} else if (isMain) {
  for (const title of titles) {
    try {
      const r = await fetchChart(title);
      if (!r.ok) { console.error('  ' + title + ': ' + r.why); continue; }
      writeFileSync(path.join(OUT, r.fn), JSON.stringify(r.chart, null, 1), 'utf8');
      const d = r.chart;
      const okMark = d.declaredHolds == null
        ? ''
        : (d.measuredHolds === d.declaredHolds ? ' ✅ 与声明一致' : ` ❌ 差 ${d.measuredHolds - d.declaredHolds}`);
      console.log(title);
      console.log(`  小节=${d.measures.length}  声明音符=${d.declaredNotes}  声明长押=${d.declaredHolds ?? '?'}`);
      console.log(`  算出长押=${d.measuredHolds}${okMark}`);
      console.log(`  -> data/memo/${r.fn}`);
    } catch (e) {
      console.error('  ' + title + ' 失败: ' + e.message);
    }
  }
}
