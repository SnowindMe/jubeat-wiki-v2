// 谱面数据层（构建时）：读取 data/chart/*.json，按 歌名+难度 建索引
//
// 数据来自 scripts/fetch-mcz.mjs —— 从 .mcz 谱面包抽出的 .mc（Malody 格式）。
// 与旧的 memo 文本方案相比：长押是结构化的（起止键位 + 秒级时间），无需再从符号推断。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CHART_DIR = path.join(process.cwd(), 'data', 'chart');

/** 曲名归一化，用于跨数据源匹配 */
export function normTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 载入全部谱面。
 * @returns {{ bySong: Map<string, {bsc?:object,adv?:object,ext?:object}>, count:number }}
 */
export function loadCharts() {
  const bySong = new Map();
  let count = 0;
  if (!existsSync(CHART_DIR)) return { bySong, count };

  for (const f of readdirSync(CHART_DIR)) {
    if (!f.endsWith('.json')) continue;
    let chart;
    try {
      chart = JSON.parse(readFileSync(path.join(CHART_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!chart || !chart.song || !chart.difficulty) continue;
    const key = normTitle(chart.song);
    if (!bySong.has(key)) bySong.set(key, {});
    bySong.get(key)[chart.difficulty] = chart;
    count++;
  }
  return { bySong, count };
}

/** 为某首歌取各难度谱面 */
export function chartsForSong(index, song) {
  return index.bySong.get(normTitle(song.title)) || null;
}
