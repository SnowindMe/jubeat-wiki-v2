// jubeat memo 抓取器：真实 Chrome + CDP 过 Cloudflare，直接产出 JSON
//
// 为什么是 JSON：hold（长押）的判定依赖「哪些字符在 <a> 内」，这是 atwiki 的 DOM 属性，
// 纯文本拿不到。硬塞进 txt 会让宽度判断处处别扭，JSON 能原生表达。
//
// 用法:
//   node scripts/fetch-memo.mjs --status                 查看已抓进度
//   node scripts/fetch-memo.mjs --url <u> [--out f]      抓单个谱面页
//   node scripts/fetch-memo.mjs --index <u> [--source s] 抓索引页，导出可抓清单
//   node scripts/fetch-memo.mjs --batch <n> [--source s] 从清单批量抓
//
// 关键实测结论（详见 docs/MEMO-FORMAT.md）:
//  - Cloudflare 拦截 headless，必须用非 headless 真实窗口
//  - 判稳用 body.innerText 长度恒定，且必须读到 "Notes: N"
//  - 小节之间会插入 "BPM:" 标记，必须跳过而不是终止
//  - 索引页 URL 必须逐行按单元格取，不能按出现次序配对

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countNotes, parseMemo } from '../src/lib/memo-parser.js';

const MEMO_DIR = path.join(process.cwd(), 'data', 'memo');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(process.cwd(), '.memo-chrome-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 页面探针 ----------
// 逐行重建 memo：文本 + 该行中处于 <a> 内的字符（hold 判定所需）
const PROBE = `(() => {
  const b = document.body;
  const t = b ? b.innerText : '';
  let best = null, bestScore = 0;
  for (const el of document.querySelectorAll('div, pre, p, table')) {
    const m = (el.innerText || '').match(/[\\u2460-\\u2473]/g);
    const score = m ? m.length : 0;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  const rows = [];
  if (best) {
    let cur = { t: '', links: [] };
    const walk = (node, inLink) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          cur.t += child.textContent;
          if (inLink) for (const ch of child.textContent) cur.links.push(ch);
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'br') { rows.push(cur); cur = { t: '', links: [] }; continue; }
          walk(child, inLink || tag === 'a');
        }
      }
    };
    walk(best, false);
    rows.push(cur);
  }
  return JSON.stringify({
    title: document.title,
    bodyText: t,
    symbolCount: (t.match(/[\\u53e3\\u25a1]/g) || []).length,
    rows: rows.map(r => ({ t: r.t, links: [...new Set(r.links)] })),
  });
})()`;

const INDEX_TABLE_PROBE = `(() => {
  const rows = [...document.querySelectorAll('tr')].map(tr =>
    [...tr.children].map(td => ({
      text: td.textContent.trim(),
      links: [...td.querySelectorAll('a')].map(a => ({ t: a.textContent.trim(), href: a.href })),
    }))
  );
  return JSON.stringify({ title: document.title, rows });
})()`;

// ---------- 文本工具 ----------
const MEMO_NOISE_RE = /^(BPM|Notes|Level|TOTAL|Total)\s*[:：]/i;

/** COSMOS 用 口，SONICY 用 □ —— 统一成 □ */
export function normalizeMemo(text) {
  return text.replace(/\u53e3/g, '\u25a1').replace(/\uFF5C/g, '|');
}

/** 识别一行属于 memo 的哪一类 */
const SCORE_RE = /^[^\s|]{0,8}\s*\|[^|]*\|/;
const BAREGRID_RE = /^[^\s|]{4}$/;

/** 从页面行里切出 memo 区（保留链接信息） */
export function sliceMemoRows(rows) {
  let start = rows.findIndex((r) => SCORE_RE.test(r.t.trim()) || BAREGRID_RE.test(r.t.trim()));
  if (start < 0) return null;
  while (start > 0 && /^\d{1,4}$/.test(rows[start - 1].t.trim())) start--;

  const out = [];
  let blankRun = 0;
  for (let i = start; i < rows.length; i++) {
    const line = rows[i].t.trim();
    if (/^\d{1,4}$/.test(line) || SCORE_RE.test(line) || BAREGRID_RE.test(line)) {
      out.push({ text: normalizeMemo(line), links: rows[i].links || [] });
      blankRun = 0;
      continue;
    }
    if (line === '') { blankRun++; if (blankRun > 3) break; continue; }
    if (MEMO_NOISE_RE.test(line)) { blankRun = 0; continue; }
    break;
  }
  return out;
}

/**
 * 把 memo 行转成结构化 JSON。
 *
 * 每行输出：{ grid, axis, hold, starts }
 *   grid   归一化后的 4 格铺面（hold 标记替换为 □，保持列对齐）
 *   axis   节奏谱字符串或 null
 *   hold   长度 4 的数组，每格是该格的 hold 标记字符（∨ ∧ ＜ ＞ ｜ ― |）或 null
 *   starts 长度 4 的布尔数组，标记该格数字**在页面上是超链接**（= hold 起点）
 *
 * 语义（用户确认 + 实测，见 docs/MEMO-FORMAT.md §6）：
 *   尾部 = ＜＞∨∧（在行的上方），起点 = 带链接的数字（在下方），｜― 是延伸线。
 *   按下起点时，三角朝起点方向收拢。
 */
export function rowsToJson(memoRows) {
  const measures = [];
  let cur = null;

  for (const row of memoRows) {
    const line = row.text;
    if (/^\d{1,4}$/.test(line)) {
      if (cur) measures.push(cur);
      cur = { no: +line, rows: [] };
      continue;
    }
    if (!cur) continue;

    const split = splitGridAxis(line);
    if (!split) continue;

    const links = new Set(row.links || []);
    const { grid, hold, starts } = normalizeGrid(split.grid, links);
    if (!grid) continue;

    cur.rows.push({
      grid: grid.join(''),
      axis: split.axis,
      hold: hold.map((h) => (h === '\u25a1' ? null : h)),
      starts,
    });
  }
  if (cur) measures.push(cur);
  return measures;
}

/** 判断字符是否为 hold 相关标记 */
const HOLD_CHAR_RE = /[\u2228\u2227\uFF1C\uFF1E\u253C\u2015\uFF5C|]/;

/** 节奏谱字符范围 */
const AXIS_CHAR_RE = /[\u2460-\u2473\u3251-\u325f\uFF0D\u2015\u2014\u30FC\u2500]/;

/**
 * 把一行拆成 [铺面, 节奏谱]。
 * 难点：铺面里也含 |（hold 延伸线），不能简单按 | 切。
 * 做法：从行尾找最后一个 |，往左扫，遇到非节奏谱字符即分界。
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
 * 归一化铺面为 4 格，并抽出每格的 hold 标记与「起点数字」。
 * hold 标记占一格，替换为 □ 以保持列对齐。
 * @returns {{grid: string[]|null, hold: (string|null)[], starts: boolean[]}}
 */
export function normalizeGrid(gridText, linkSet) {
  const hold = [null, null, null, null];
  const starts = [false, false, false, false];
  let clean = '';
  let col = -1;
  for (const ch of gridText) {
    if (HOLD_CHAR_RE.test(ch)) {
      col++;
      if (col < 4) hold[col] = ch;
      clean += '\u25a1';
      continue;
    }
    if (ch === ' ' || ch === '\u3000') continue;
    col++;
    // 带链接的数字 = hold 起点（链接信息只在 DOM 里，纯文本拿不到）
    if (col < 4 && linkSet && linkSet.has(ch)) starts[col] = true;
    clean += ch;
  }
  let chars = [...clean];
  if (chars.length !== 4) {
    if (chars.length < 4 && chars.every((c) => /[\u53e3\u25a1]/.test(c))) {
      while (chars.length < 4) { chars.push('\u25a1'); }
    } else {
      return { grid: null, hold, starts };
    }
  }
  return { grid: chars, hold, starts };
}

// ---------- Chrome/CDP ----------
function launchChrome(port, profile) {
  return spawn(CHROME, [
    '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1280,900', '--window-position=-2400,-2400',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });
}

async function makeSession(port, proc) {
  let ver;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
    if (proc.exitCode !== null) throw new Error('Chrome 提前退出');
    await sleep(300);
  }
  if (!ver) throw new Error('devtools 未就绪');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page')
    || { targetId: (await send('Target.createTarget', { url: 'about:blank' })).targetId };
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  return { ws, send, sessionId };
}

// ---------- 抓一页 ----------
async function grabChart(sess, url, meta = {}, { retries = 2 } = {}) {
  const { send, sessionId } = sess;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await send('Page.navigate', { url }, sessionId);
    let prevBody = -1, stable = 0, info = null;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const { result } = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
      info = JSON.parse(result.value || '{}');
      const title = info.title || '';
      if (/just a moment|请稍候|challenge|attention required/i.test(title)) { stable = 0; continue; }
      const bodyLen = (info.bodyText || '').length;
      const hasMemo = (info.symbolCount || 0) > 20;
      const hasNotes = /Notes:\s*\d+/.test(info.bodyText || '');
      if (hasMemo && hasNotes && bodyLen === prevBody) stable++; else stable = 0;
      prevBody = bodyLen;
      if (hasMemo && hasNotes && stable >= 2) break;
    }

    const memoRows = sliceMemoRows(info?.rows || []);
    if (memoRows && memoRows.length > 8) {
      const measures = rowsToJson(memoRows);
      const declared = (String(info.bodyText || '').match(/Notes:\s*(\d+)/) || [])[1];
      const plain = memoRows.map((r) => r.text).join('\n');
      // 把「哪些格是 hold 起点」交给解析器，才能算出真实的 hold 数
      const holdStarts = [];
      for (const m of measures) {
        m.rows.forEach((r, rowIdx) => {
          (r.starts || []).forEach((isStart, col) => {
            if (isStart) holdStarts.push({ measure: m.no, row: rowIdx, col });
          });
        });
      }
      const parsed = parseMemo(plain, { holdStarts });
      return {
        ok: true,
        data: {
          schema: 1,
          song: meta.title || null,
          difficulty: meta.diff || null,
          source: meta.source || null,
          url,
          pageTitle: info.title,
          bpm: meta.bpm ?? (String(info.bodyText).match(/BPM:\s*([\d.\-]+)/) || [])[1] ?? null,
          declaredNotes: declared ? +declared : null,
          parsedNotes: parsed.stats.noteCount,
          holdCount: parsed.stats.holdCount,
          measures,
        },
      };
    }
    await sleep(2500 * (attempt + 1));
  }
  return { ok: false, url, error: '未取到 memo 区' };
}

// ---------- 索引页 ----------
export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
}

const DIFF_LABEL = { 3: 'BSC', 4: 'ADV', 5: 'EXT' };

export function parseIndexRows(rows, source) {
  const out = [];
  const cellText = (c) => (typeof c === 'string' ? c : (c && c.text) || '').trim();
  for (const cells of rows) {
    if (!cells || cells.length < 6) continue;
    const title = cellText(cells[0]);
    if (!title || /^Music$|^LEVEL/i.test(title)) continue;
    for (const ci of [3, 4, 5]) {
      const cell = cells[ci];
      const m = cellText(cell).match(/Lv\s*([\d.]+)\s*\((\d+)\)/);
      if (!m) continue;
      const href = cell && cell.links && cell.links[0] && cell.links[0].href;
      out.push({
        title, diff: DIFF_LABEL[ci], level: m[1], notes: +m[2], source,
        url: href ? new URL(href, 'https://w.atwiki.jp').href : null,
      });
    }
  }
  return out;
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);

async function main() {
  mkdirSync(MEMO_DIR, { recursive: true });

  const newPort = () => 9300 + Math.floor(Math.random() * 400);
  const spawnChrome = () => {
    rmSync(PROFILE, { recursive: true, force: true });
    const port = newPort();
    return { proc: launchChrome(port, PROFILE), port };
  };
  const cleanup = async (sess, proc) => {
    try { sess?.ws.close(); } catch {}
    proc.kill('SIGKILL');
    await sleep(1200);
    try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  };

  if (has('--status')) {
    const files = readdirSync(MEMO_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    const byDiff = {};
    let notes = 0, holds = 0;
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(path.join(MEMO_DIR, f), 'utf8'));
        byDiff[j.difficulty || '?'] = (byDiff[j.difficulty || '?'] || 0) + 1;
        notes += j.parsedNotes || 0;
        holds += j.holdCount || 0;
      } catch {}
    }
    console.log(`已抓 ${files.length} 个谱面（JSON）`);
    console.log('按难度:', JSON.stringify(byDiff));
    console.log(`累计音符 ${notes}，已配对 hold ${holds}`);
    return;
  }

  if (has('--url')) {
    const url = arg('--url');
    const outFile = arg('--out') || path.join(MEMO_DIR, `chart-${Date.now()}.json`);
    const { proc, port } = spawnChrome();
    let sess;
    try {
      sess = await makeSession(port, proc);
      const r = await grabChart(sess, url);
      if (!r.ok) { console.error('失败:', r.error); process.exitCode = 1; }
      else {
        writeFileSync(outFile, JSON.stringify(r.data, null, 1), 'utf8');
        const d = r.data;
        const holdRows = d.measures.reduce((a, m) => a + m.rows.filter((x) => x.hold.some(Boolean)).length, 0);
        console.log(`OK  ${d.pageTitle}`);
        console.log(`    小节=${d.measures.length}  解析音符=${d.parsedNotes}  声明=${d.declaredNotes ?? '?'}  配对hold=${d.holdCount}`);
        console.log(`    BPM=${d.bpm}  含hold标记的行=${holdRows}`);
        console.log(`    -> ${path.relative(process.cwd(), outFile)}`);
      }
    } finally { await cleanup(sess, proc); }
    return;
  }

  if (has('--index')) {
    const url = arg('--index');
    const source = arg('--source') || (url.includes('cosmos') ? 'cosmos' : 'sonicy');
    const { proc, port } = spawnChrome();
    let sess;
    try {
      sess = await makeSession(port, proc);
      await sess.send('Page.navigate', { url }, sess.sessionId);
      let tbl = null;
      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        const { result } = await sess.send('Runtime.evaluate', { expression: INDEX_TABLE_PROBE, returnByValue: true }, sess.sessionId);
        const j = JSON.parse(result.value || '{}');
        if (/just a moment|请稍候|challenge/i.test(j.title || '')) continue;
        if ((j.rows || []).length > 20) { tbl = j; break; }
      }
      if (!tbl) { console.error('索引页未取到'); process.exitCode = 1; }
      else {
        const idx = parseIndexRows(tbl.rows, source);
        const counts = {};
        for (const it of idx) counts[it.diff] = (counts[it.diff] || 0) + 1;
        const withUrl = idx.filter((x) => x.url).length;
        console.log(`索引页 "${tbl.title}" -> ${idx.length} 条（含URL ${withUrl}）`);
        console.log('按难度:', JSON.stringify(counts));
        for (const it of idx.slice(0, 5)) console.log(`   ${it.title} [${it.diff}] Lv${it.level} notes=${it.notes} ${it.url || '(无URL)'}`);
        writeFileSync(path.join(MEMO_DIR, `_index-${source}.json`), JSON.stringify(idx, null, 2), 'utf8');
        console.log(`-> data/memo/_index-${source}.json`);
      }
    } finally { await cleanup(sess, proc); }
    return;
  }

  if (has('--batch')) {
    const n = parseInt(arg('--batch') || '20', 10);
    const source = arg('--source') || 'cosmos';
    const idxFile = arg('--index-file') || path.join(MEMO_DIR, `_index-${source}.json`);
    if (!existsSync(idxFile)) { console.error(`清单不存在: ${idxFile}（先跑 --index）`); process.exitCode = 1; return; }
    const list = JSON.parse(readFileSync(idxFile, 'utf8'));

    const todo = [];
    for (const it of list) {
      const fn = `${safeName(it.title)}-${it.diff}-${it.source}.json`;
      if (existsSync(path.join(MEMO_DIR, fn))) continue;
      todo.push({ ...it, fn });
    }
    console.log(`清单 ${list.length} 条，未抓 ${todo.length} 条，本次抓 ${Math.min(n, todo.length)} 条`);
    if (!todo.length) { console.log('全部已抓完'); return; }

    const batch = todo.slice(0, n);
    const { proc, port } = spawnChrome();
    let sess;
    const ok = [], bad = [];
    try {
      sess = await makeSession(port, proc);
      for (let i = 0; i < batch.length; i++) {
        const it = batch[i];
        if (!it.url) { bad.push({ ...it, why: '无URL' }); continue; }
        const r = await grabChart(sess, it.url, it, { retries: 1 });
        if (!r.ok) {
          bad.push({ ...it, why: r.error });
          console.log(`  [${i + 1}/${batch.length}] FAIL ${it.title} ${it.diff}`);
          continue;
        }
        writeFileSync(path.join(MEMO_DIR, it.fn), JSON.stringify(r.data, null, 1), 'utf8');
        const got = r.data.parsedNotes;
        const expect = r.data.declaredNotes ?? it.notes;
        const match = got === expect;
        ok.push({ ...it, got, expect, match, holds: r.data.holdCount });
        console.log(`  [${i + 1}/${batch.length}] ${match ? 'OK  ' : 'MISM'} ${it.fn}  notes=${got}/${expect} hold=${r.data.holdCount}`);
        await sleep(400 + Math.random() * 600);
      }
    } finally { await cleanup(sess, proc); }

    console.log(`\n成功 ${ok.length}，失败 ${bad.length}`);
    const totalHolds = ok.reduce((a, x) => a + (x.holds || 0), 0);
    console.log(`本次配对 hold 合计 = ${totalHolds}`);
    const mism = ok.filter((x) => !x.match);
    if (mism.length) {
      console.log(`⚠️ 音符数不吻合 ${mism.length} 条:`);
      for (const m of mism.slice(0, 10)) console.log(`   ${m.fn}: ${m.got} vs ${m.expect}`);
    }
    for (const b of bad.slice(0, 10)) console.log(`   失败: ${b.title} ${b.diff} — ${b.why}`);
    return;
  }

  console.log('jubeat memo 抓取器（输出 JSON）');
  console.log('  --status                     查看进度');
  console.log('  --url <u> [--out f]          抓单个谱面页');
  console.log('  --index <u> [--source s]     抓索引页，导出清单');
  console.log('  --batch <n> [--source s]     批量抓（断点续抓 + 自动校验）');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
  process.exit(process.exitCode || 0);
}
