// 谱面 memo 数据层：构建时读取 data/memo/*.txt，按 歌曲+难度 建立索引
//
// 约定（来自抓取器的命名规范）：[歌名]-[难度]-[版本].txt
//   Megalara Garuda-EXT-cosmos.txt
//   yellow_head_joe-BSC-sonicy.txt
//
// 数据来源：SONICY memo / COSMOS memo 两个 atwiki 站点，由 scripts/fetch-memo.mjs 抓取。
// 这些文件位于 data/memo/（.gitignore 忽略），构建机需先执行抓取。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ⚠️ 不能用 import.meta.url 推导项目根目录：
//    Astro/Vite 打包后该模块位于 .astro/ 缓存目录，路径会错，导致读到 0 个文件。
//    构建与脚本都在项目根目录执行，用 process.cwd() 才可靠。
const root = process.cwd();
const MEMO_DIR = path.join(root, 'data', 'memo');

/** 难度标记（与 songs.json 的 levels 键一致） */
const DIFFS = ['bsc', 'adv', 'ext'];

/** 把曲名归一化，用于跨来源匹配：忽略大小写、空白、标点、全半角差异 */
export function normTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角->半角
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 解析文件名 -> { title, diff, source } */
export function parseMemoFilename(file) {
  const base = file.replace(/\.txt$/i, '');
  const parts = base.split('-');
  if (parts.length < 3) return null;
  const source = parts[parts.length - 1];
  const diff = (parts[parts.length - 2] || '').toLowerCase();
  const title = parts.slice(0, -2).join('-');
  if (!DIFFS.includes(diff)) return null;
  return { title, diff, source };
}

/**
 * 读取全部谱面并建立索引。
 * 支持两种文件：
 *   - [歌名]-[难度]-[版本].json  含 hold 信息（推荐，抓取器当前输出）
 *   - [歌名]-[难度]-[版本].txt   纯文本，无 hold（早期数据）
 * 同难度下优先用 JSON。
 * @returns {{ bySong: Map, count:number, files:string[], hasHold:number }}
 */
export function loadMemoIndex() {
  const bySong = new Map();
  const files = [];
  let hasHold = 0;
  if (!existsSync(MEMO_DIR)) return { bySong, count: 0, files, hasHold };

  for (const f of readdirSync(MEMO_DIR)) {
    if (f.startsWith('_')) continue;
    const isJson = f.toLowerCase().endsWith('.json');
    const isTxt = f.toLowerCase().endsWith('.txt');
    if (!isJson && !isTxt) continue;
    const meta = parseMemoFilename(f);
    if (!meta) continue;

    let entry = null;
    try {
      const raw = readFileSync(path.join(MEMO_DIR, f), 'utf8');
      if (isJson) {
        const j = JSON.parse(raw);
        if (!j.measures || !j.measures.length) continue;
        // 把 JSON 的行结构转回解析器需要的文本 + holdStarts
        const lines = [];
        const holdStarts = [];
        for (const m of j.measures) {
          lines.push(String(m.no));
          m.rows.forEach((r, rowIdx) => {
            // 还原成可解析的文本行：铺面 + 可选节奏谱
            lines.push(r.axis ? `${r.grid} |${r.axis}|` : r.grid);
            (r.starts || []).forEach((isStart, col) => {
              if (isStart) holdStarts.push({ measure: m.no, row: rowIdx, col });
            });
          });
        }
        // hold 标记（∨ ｜ 等）在 grid 里已被替换为 □，还原回标记以便解析器统计
        const restored = j.measures.map((m) =>
          m.rows.map((r) => {
            const chars = [...r.grid];
            (r.hold || []).forEach((mk, col) => {
              if (mk) chars[col] = mk;
            });
            return r.axis ? `${chars.join('')} |${r.axis}|` : chars.join('');
          }),
        );
        const text = [];
        j.measures.forEach((m, i) => {
          text.push(String(m.no));
          text.push(...restored[i]);
        });
        entry = { ...meta, memo: text.join('\n'), holdStarts, file: f, json: j };
        if (holdStarts.length) hasHold++;
      } else {
        if (!raw || raw.length < 40) continue;
        entry = { ...meta, memo: raw, holdStarts: null, file: f };
      }
    } catch {
      continue;
    }
    if (!entry) continue;

    const key = normTitle(meta.title);
    if (!bySong.has(key)) bySong.set(key, {});
    const slot = bySong.get(key);
    // 同一难度：JSON 优先；同为 JSON 时 COSMOS 优先
    const prev = slot[meta.diff];
    const better =
      !prev ||
      (prev.json == null && entry.json != null) ||
      (prev.source !== 'cosmos' && meta.source === 'cosmos' && (prev.json != null) === (entry.json != null));
    if (better) slot[meta.diff] = entry;
    files.push(f);
  }
  return { bySong, count: files.length, files, hasHold };
}

/** 为某首歌取各难度谱面 */
export function memoForSong(index, song) {
  const slot = index.bySong.get(normTitle(song.title));
  if (!slot) return null;
  return slot;
}
