// jubeat memo 抓取器：真实 Chrome + CDP 过 Cloudflare，抓 memo 文本并落盘
//
// 用法:
//   node scripts/fetch-memo.mjs --status                 查看已抓进度
//   node scripts/fetch-memo.mjs --url <u> [--out f]      抓单个谱面页
//   node scripts/fetch-memo.mjs --index <u> [--source s] 抓索引页，导出可抓清单 JSON
//   node scripts/fetch-memo.mjs --batch <n> [--source s] 从清单批量抓（断点续抓 + 自动校验）
//
// 设计要点（均来自实测，详见 docs/MEMO-FORMAT.md）:
//  - atwiki 有 Cloudflare managed challenge，必须真实浏览器执行 JS
//  - ⚠️ Cloudflare 拦截 headless：必须用非 headless 真实窗口（见 launchChrome）
//  - 判稳用 body.innerText 长度恒定（整页 html 因广告脚本永远在变）
//  - 硬判据：必须读到页面自己的 "Notes: N" 才认为渲染完成
//  - hold 信息在超链接里，额外从 <a> 提取
//  - 断点续抓：目标文件已存在则跳过

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countNotes } from '../src/lib/memo-parser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'data', 'memo');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- memo 文本规范化 ----------
// COSMOS 用 口(空位)，SONICY 用 □；统一成 □ 便于下游解析
export function normalizeMemo(text) {
  return text
    .replace(/\u53e3/g, '\u25a1') // 口 -> □
    .replace(/\uFF5C/g, '|');      // ｜ -> |
}

// ---------- 从整页 innerText 里切出 memo 区 ----------
// ⚠️ 实测坑：atwiki 的 memo 页面会在**小节之间**插入 "BPM: 180" 这样的标记
//    （表示此处发生变 BPM）。早期实现把非谱面行一律视为结束标志，
//    结果遇到第一个 "BPM:" 就把后面 90% 的谱面全丢掉（Diastrophism 1000 -> 36）。
//    因此必须「跳过」这类标记而不是终止。
const MEMO_NOISE_RE = /^(BPM|Notes|Level|TOTAL|Total)\s*[:：]/i;

export function extractMemoRegion(bodyText) {
  const lines = bodyText.split(/\r?\n/).map((l) => l.trimEnd());
  const scoreRe = /^[^\s|]{4}\s*\|[^|]*\|/;
  const bareGridRe = /^[^\s|]{1,4}$/;
  let start = lines.findIndex((l) => scoreRe.test(l.trim()));
  if (start < 0) return null;
  // 往回把小节号纳入
  while (start > 0 && /^\d{1,4}$/.test(lines[start - 1].trim())) start--;

  const out = [];
  let blankRun = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    // 谱面标记：小节号 / 带节奏谱的行 / 裸铺面行
    if (/^\d{1,4}$/.test(l) || scoreRe.test(l) || bareGridRe.test(l)) {
      out.push(l);
      blankRun = 0;
      continue;
    }
    if (l === '') {
      blankRun++;
      if (blankRun > 3) break;
      continue;
    }
    // 小节之间的 BPM/Notes 等标记：跳过但**不终止**
    if (MEMO_NOISE_RE.test(l)) { blankRun = 0; continue; }
    break; // 真正的页脚/评论区
  }
  return out.join('\n');
}

// ---------- Chrome/CDP ----------
// ⚠️ 实测（2026-09）：atwiki 的 Cloudflare 会拦截 headless。
//    必须用「非 headless」真实窗口模式，headless=new / headless=old 全部卡在「请稍候…」。
//    窗口移到屏幕外即可，不影响抓取。
function launchChrome(port, profile) {
  return spawn(
    CHROME,
    [
      '--disable-gpu', '--no-sandbox',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--window-size=1280,900', '--window-position=-2400,-2400',
      '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

async function makeSession(port, proc) {
  let ver;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch {}
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
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page')
    || { targetId: (await send('Target.createTarget', { url: 'about:blank' })).targetId };
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  return { ws, send, sessionId };
}

// 页面信息快照（含短符号链接，用于识别 hold）
const PROBE = `(() => {
  const b = document.body;
  const t = b ? b.innerText : '';
  const shortLinks = [...document.querySelectorAll('a')]
    .map(a => ({ t: a.textContent, href: a.getAttribute('href') || '' }))
    .filter(x => x.t && x.t.length <= 2);
  return JSON.stringify({
    title: document.title,
    bodyText: t,
    symbolCount: (t.match(/[\u53e3\u25a1]/g) || []).length,
    shortLinks,
  });
})()`;

// ---------- 抓一页 ----------
async function grabPage(sess, url, { retries = 2 } = {}) {
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
      // 硬判据：读到自己页面的 "Notes: N"，且正文长度稳定
      const hasNotes = /Notes:\s*\d+/.test(info.bodyText || '');
      if (hasMemo && hasNotes && bodyLen === prevBody) stable++; else stable = 0;
      prevBody = bodyLen;
      if (hasMemo && hasNotes && stable >= 2) break;
    }

    const region = extractMemoRegion(info?.bodyText || '');
    if (region && region.length > 40) {
      const declared = (String(info.bodyText || '').match(/Notes:\s*(\d+)/) || [])[1];
      return {
        ok: true,
        url,
        title: info.title,
        attempts: attempt + 1,
        region: normalizeMemo(region),
        declaredNotes: declared ? +declared : null,
        holdSymbols: [...new Set((info.shortLinks || [])
          .filter((l) => /(?:pages|atwiki)/.test(l.href)
            && /^[\u2460-\u2473\u3251-\u325f\uFF5C\u2015\uFF0D\uFF1C\uFF1E\u2228\u2227\u253C]$/.test(l.t))
          .map((l) => l.t))],
      };
    }
    await sleep(2500 * (attempt + 1));
  }
  return { ok: false, url, error: '未取到 memo 区' };
}

// ---------- 索引页解析 ----------
// 命名规范（用户指定）：[歌名]-[难度]-[版本].txt
export function safeName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}

const DIFF_LABEL = { 3: 'BSC', 4: 'ADV', 5: 'EXT' }; // 表头列序：Music/Artist/BPM/BASIC/ADVANCED/EXTREME

// 索引页是标准 HTML 表格（Music | Artist | BPM | BASIC | ADVANCED | EXTREME）。
// ⚠️ 实测坑：不要用「innerText 行顺序 + 链接全局顺序」配对 URL —— DOM 中链接顺序
//    与 innerText 行顺序并不一致，会张冠李戴（把 Sky High 的页面挂到 Couleur=Blanche 上）。
//    必须逐行按单元格取，URL 跟着单元格走。
export function parseIndexRows(rows, source) {
  const out = [];
  const cellText = (c) => (typeof c === 'string' ? c : (c && c.text) || '').trim();

  for (const cells of rows) {
    if (!cells || cells.length < 6) continue;
    const title = cellText(cells[0]);
    if (!title || /^Music$|^LEVEL/i.test(title)) continue;
    for (const ci of [3, 4, 5]) {
      const cell = cells[ci];
      const text = cellText(cell);
      const m = text.match(/Lv\s*([\d.]+)\s*\((\d+)\)/);
      if (!m) continue;
      const href = cell && cell.links && cell.links[0] && cell.links[0].href;
      out.push({
        title,
        diff: DIFF_LABEL[ci],
        level: m[1],
        notes: +m[2],
        source,
        url: href ? new URL(href, 'https://w.atwiki.jp').href : null,
      });
    }
  }
  return out;
}

// 从页面里抽取表格行（曲名 + 难度单元格 + 单元格内链接）
const INDEX_TABLE_PROBE = `(() => {
  const rows = [...document.querySelectorAll('tr')].map(tr =>
    [...tr.children].map(td => ({
      text: td.textContent.trim(),
      links: [...td.querySelectorAll('a')].map(a => ({ t: a.textContent.trim(), href: a.href })),
    }))
  );
  return JSON.stringify({ title: document.title, rows });
})()`;

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);

const newPort = () => 9300 + Math.floor(Math.random() * 400);
const PROFILE = path.join(root, '.memo-chrome-profile');

async function main() {
  mkdirSync(OUT, { recursive: true });

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
    const files = readdirSync(OUT).filter((f) => f.endsWith('.txt'));
    const byDiff = {};
    for (const f of files) {
      const d = f.replace(/\.txt$/, '').split('-')[1] || '?';
      byDiff[d] = (byDiff[d] || 0) + 1;
    }
    console.log(`已抓 ${files.length} 个谱面文件`);
    console.log('按难度:', JSON.stringify(byDiff));
    if (files.length) console.log('示例:', files.slice(0, 6).join(', '));
    return;
  }

  if (has('--url')) {
    const url = arg('--url');
    const outFile = arg('--out') || path.join(OUT, `chart-${Date.now()}.txt`);
    const port = newPort();
    rmSync(PROFILE, { recursive: true, force: true });
    const proc = launchChrome(port, PROFILE);
    let sess;
    try {
      sess = await makeSession(port, proc);
      const r = await grabPage(sess, url);
      if (!r.ok) { console.error('失败:', r.error); process.exitCode = 1; }
      else {
        writeFileSync(outFile, r.region, 'utf8');
        const measures = (r.region.match(/^\d{1,4}$/gm) || []).length;
        const notes = countNotes(r.region);
        console.log(`OK  title="${r.title}"`);
        console.log(`    小节≈${measures}  音符=${notes}  声明=${r.declaredNotes ?? '?'}  字符=${r.region.length}`);
        console.log(`    hold符号=${r.holdSymbols.join('') || '(无)'}`);
        console.log(`    -> ${path.relative(root, outFile)}`);
      }
    } finally {
      await cleanup(sess, proc);
    }
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
        console.log(`索引页 "${tbl.title}" -> ${idx.length} 条谱面（含URL ${withUrl}）`);
        console.log('按难度:', JSON.stringify(counts));
        console.log('前 5 条:');
        for (const it of idx.slice(0, 5)) {
          console.log(`   ${it.title} [${it.diff}] Lv${it.level} notes=${it.notes} ${it.url || '(无URL)'}`);
        }
        writeFileSync(path.join(OUT, `_index-${source}.json`), JSON.stringify(idx, null, 2), 'utf8');
        console.log(`-> data/memo/_index-${source}.json`);
      }
    } finally {
      await cleanup(sess, proc);
    }
    return;
  }

  if (has('--batch')) {
    const n = parseInt(arg('--batch') || '20', 10);
    const source = arg('--source') || 'cosmos';
    const idxFile = arg('--index-file') || path.join(OUT, `_index-${source}.json`);
    if (!existsSync(idxFile)) { console.error(`清单不存在: ${idxFile}（先跑 --index）`); process.exitCode = 1; return; }
    const list = JSON.parse(readFileSync(idxFile, 'utf8'));

    const todo = [];
    for (const it of list) {
      const fn = `${safeName(it.title)}-${it.diff}-${it.source}.txt`;
      if (existsSync(path.join(OUT, fn))) continue;
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
        const r = await grabPage(sess, it.url, { retries: 1 });
        if (!r.ok) {
          bad.push({ ...it, why: r.error });
          console.log(`  [${i + 1}/${batch.length}] FAIL ${it.title} ${it.diff}`);
          continue;
        }
        writeFileSync(path.join(OUT, it.fn), r.region, 'utf8');
        const parsed = countNotes(r.region);
        const expect = r.declaredNotes ?? it.notes;
        const match = parsed === expect;
        ok.push({ ...it, parsed, expect, match });
        console.log(`  [${i + 1}/${batch.length}] ${match ? 'OK  ' : 'MISM'} ${it.fn}  parsed=${parsed} declared=${expect}${r.declaredNotes == null ? '(from-index)' : ''}`);
        await sleep(400 + Math.random() * 600);
      }
    } finally {
      await cleanup(sess, proc);
    }
    console.log(`\n本次成功 ${ok.length}，失败 ${bad.length}`);
    const mism = ok.filter((x) => !x.match);
    if (mism.length) {
      console.log(`⚠️ 音符数不吻合 ${mism.length} 条（需人工核查）:`);
      for (const m of mism.slice(0, 10)) console.log(`   ${m.fn}: parsed=${m.parsed} declared=${m.expect}`);
    }
    for (const b of bad.slice(0, 10)) console.log(`   失败: ${b.title} ${b.diff} — ${b.why}`);
    return;
  }

  console.log('jubeat memo 抓取器');
  console.log('  --status                     查看已抓进度');
  console.log('  --url <u> [--out f]          抓单个谱面页');
  console.log('  --index <u> [--source s]     抓索引页，导出可抓清单 JSON');
  console.log('  --batch <n> [--source s]     从清单批量抓（断点续抓，自动校验音符数）');
}

// 仅在作为脚本直接运行时执行；被 import 时只导出函数
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
  process.exit(process.exitCode || 0);
}
