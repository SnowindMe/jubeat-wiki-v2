// mywiki.cn（cosmos memo 备份站）抓取器
// 优势：无 Cloudflare（直连 fetch 即可）、hold 用 <font color="red"> 包裹（比超链接更好解析）、
//       页面带 "Notes: N (H)" 提供 hold 数校验锚点
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'memo');
mkdirSync(OUT, { recursive: true });

const BASE = 'https://www.mywiki.cn/cosmosmemo/';

const isCircle = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x2460 && c <= 0x2473;
};
const TRI = /[\u2228\u2227\uFF1C\uFF1E]/;

/** 取原始 HTML */
async function fetchHtml(title) {
  const url = new URL(encodeURIComponent(title), BASE).href;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jubeat-wiki-builder/1.0' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { html: await r.text(), url };
}

/**
 * 把 memo 正文 HTML 转成「逐行 + 每行红色字符集合」。
 * memo 正文在 <div class="mw-parser-output"> 里，行由 <br /> 分隔。
 */
export function parseMemoHtml(html) {
  // 截取 memo 主体
  const m = html.match(/<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  const body = m ? m[1] : html;

  // 提取 meta
  const notesM = body.match(/Notes:\s*(\d+)\s*(?:\((\d+)\))?/);
  const bpmM = body.match(/BPM:\s*([\d.\-]+)/);
  const levelM = body.match(/Level:\s*(\d+)/);

  const rows = [];
  let cur = { t: '', red: [] };
  const pushRow = () => { rows.push(cur); cur = { t: '', red: [] }; };

  // 按 token 扫描：<br>、段落边界、<font color="red">x</font>、纯文本
  // ⚠️ MediaWiki 会把长内容切成多个 <p>，段落之间**没有 <br>**，
  //    必须把 </p> / <p> 也当作行分隔，否则会丢行（实测曾丢 57 行 / 108 个符号）。
  const re = /<br\s*\/?>|<\/p\s*>|<p[^>]*>|<font[^>]*color="red"[^>]*>([\s\S]*?)<\/font>|([^<]+)/gi;
  let match;
  while ((match = re.exec(body)) !== null) {
    const tok = match[0];
    if (/^<br/i.test(tok) || /^<\/p/i.test(tok) || /^<p/i.test(tok)) { pushRow(); continue; }
    if (match[1] != null) {
      const txt = match[1].replace(/<[^>]+>/g, '');
      cur.t += txt;
      for (const ch of txt) cur.red.push(ch);
      continue;
    }
    if (match[2] != null) cur.t += match[2];
  }
  pushRow();

  return {
    rows,
    declaredNotes: notesM ? +notesM[1] : null,
    declaredHolds: notesM && notesM[2] ? +notesM[2] : null,
    bpm: bpmM ? bpmM[1] : null,
    level: levelM ? +levelM[1] : null,
  };
}

/** 从行集合切出 memo 区（从第一个小节号开始，到页脚前） */
export function sliceMemo(rows) {
  const scoreRe = /^[^\s|]{0,8}\s*\|[^|]*\|/;
  const bareRe = /^[^\s|]{4}$/;
  let start = rows.findIndex((r) => /^\d{1,4}$/.test(r.t.trim()));
  if (start < 0) return null;
  const out = [];
  let blanks = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const t = r.t.trim();
    if (/^\d{1,4}$/.test(t) || scoreRe.test(t) || bareRe.test(t)) { out.push({ ...r, t }); blanks = 0; continue; }
    if (t === '') { blanks++; if (blanks > 3) break; continue; }
    if (/^(不確定度|检索自|分类)/.test(t)) break;
    blanks = 0;
  }
  return out;
}

/** 转成 JSON（结构对齐 atwiki 抓取器） */
export function toChartJson(title, meta, memoRows) {
  const measures = [];
  let cur = null;
  for (const r of memoRows) {
    const line = r.t;
    if (/^\d{1,4}$/.test(line)) {
      if (cur) measures.push(cur);
      cur = { no: +line, rows: [] };
      continue;
    }
    if (!cur) continue;

    // 拆 [铺面] |节奏谱|
    let gridText = line, axis = null;
    const bar = line.match(/^(.*?)\s*\|([^|]*)\|\s*$/);
    if (bar && /^[^\s|]{0,8}$/.test(bar[1].trim())) { gridText = bar[1].trim(); axis = bar[2]; }

    const reds = new Set(r.red || []);
    const hold = [null, null, null, null];
    const starts = [false, false, false, false];
    let clean = '';
    let col = -1;
    for (const raw of gridText) {
      // 统一空位符：该站用 口(U+53E3)，与 □(U+25A1) 等价
      const ch = raw === '\u53e3' ? '\u25a1' : raw;
      if (/[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/.test(ch)) {
        col++;
        if (col < 4) hold[col] = ch;
        clean += '\u25a1';
        continue;
      }
      if (ch === ' ' || ch === '\u3000') continue;
      col++;
      if (col < 4 && isCircle(ch) && reds.has(raw)) starts[col] = true;
      clean += ch;
    }
    let chars = [...clean];
    if (chars.length !== 4) {
      if (chars.length < 4 && chars.every((c) => /[\u53e3\u25a1]/.test(c))) {
        while (chars.length < 4) chars.push('\u25a1');
      } else continue;
    }
    cur.rows.push({
      grid: chars.join(''),
      axis,
      hold: hold.map((h) => (h === '\u25a1' ? null : h)),
      starts,
    });
  }
  if (cur) measures.push(cur);

  return {
    schema: 1,
    song: title.replace(/_\([^)]*\)$/, ''),
    difficulty: (title.match(/_\(([^)]+)\)$/) || [])[1] || null,
    source: 'cosmos-mywiki',
    bpm: meta.bpm,
    level: meta.level,
    declaredNotes: meta.declaredNotes,
    declaredHolds: meta.declaredHolds,
    measures,
  };
}

export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
}

// ---------- CLI ----------
const titles = process.argv.slice(2);
if (!titles.length) {
  console.log('用法: node scripts/fetch-mywiki.mjs "天空の華_(EXT)" [...]');
  process.exit(0);
}

for (const title of titles) {
  try {
    const { html, url } = await fetchHtml(title);
    const meta = parseMemoHtml(html);
    const memoRows = sliceMemo(meta.rows);
    if (!memoRows) { console.error(`  ${title}: 未找到 memo 区`); continue; }
    const chart = toChartJson(title, meta, memoRows);
    const startCount = chart.measures.reduce((a, m) => a + m.rows.reduce((b, r) => b + r.starts.filter(Boolean).length, 0), 0);
    const holdMarkRows = chart.measures.reduce((a, m) => a + m.rows.filter((r) => r.hold.some(Boolean)).length, 0);
    const fn = `${safeName(chart.song)}-${chart.difficulty}-mywiki.json`;
    writeFileSync(path.join(OUT, fn), JSON.stringify(chart, null, 1), 'utf8');
    console.log(`${title}`);
    console.log(`  小节=${chart.measures.length}  声明音符=${meta.declaredNotes}  声明hold=${meta.declaredHolds}`);
    console.log(`  识别起点=${startCount}  含hold标记的行=${holdMarkRows}`);
    console.log(`  -> data/memo/${fn}`);
  } catch (e) {
    console.error(`  ${title} 失败: ${e.message}`);
  }
}
