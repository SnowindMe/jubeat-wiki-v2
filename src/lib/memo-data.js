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
 * 读取全部 memo 并建立索引。
 * @returns {{ bySong: Map<string, {bsc?:Entry, adv?:Entry, ext?:Entry}>, count:number, files:string[] }}
 */
export function loadMemoIndex() {
  const bySong = new Map();
  const files = [];
  if (!existsSync(MEMO_DIR)) return { bySong, count: 0, files };

  for (const f of readdirSync(MEMO_DIR)) {
    if (!f.toLowerCase().endsWith('.txt') || f.startsWith('_')) continue;
    const meta = parseMemoFilename(f);
    if (!meta) continue;
    let memo;
    try {
      memo = readFileSync(path.join(MEMO_DIR, f), 'utf8');
    } catch {
      continue;
    }
    if (!memo || memo.length < 40) continue;

    const key = normTitle(meta.title);
    if (!bySong.has(key)) bySong.set(key, {});
    const slot = bySong.get(key);
    // 同一难度若已有 COSMOS（含 hold、准确度高），优先保留
    const prev = slot[meta.diff];
    if (!prev || (prev.source !== 'cosmos' && meta.source === 'cosmos')) {
      slot[meta.diff] = { ...meta, memo, file: f };
    }
    files.push(f);
  }
  return { bySong, count: files.length, files };
}

/** 为某首歌取各难度谱面 */
export function memoForSong(index, song) {
  const slot = index.bySong.get(normTitle(song.title));
  if (!slot) return null;
  return slot;
}
