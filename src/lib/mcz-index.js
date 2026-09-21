// mcz 索引（构建时）：songId -> .mcz 的 CDN 地址
//
// 只读 data/mcz/index.json（很小，几百 KB），不读也不下载任何 .mcz 本体。
// 谱面/音频/曲绘全部留给浏览器在用户点击预览时按需从 CDN 读取。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const INDEX_PATH = path.join(process.cwd(), 'data', 'mcz', 'index.json');

/**
 * @returns {Record<string, {dir:string,file:string,path:string,size:number,url:string}>}
 */
export function loadMczIndex() {
  if (!existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 某首歌的 .mcz 元信息，无则 null */
export function mczForSongId(index, songId) {
  return index[String(songId)] ?? null;
}
