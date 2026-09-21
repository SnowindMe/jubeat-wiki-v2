// mywiki.cn（cosmos memo 备份站）批量抓取
//
// 站点特性（实测）：
//   - 无 Cloudflare，直连 fetch 即可（不必用 Chrome）
//   - MediaWiki：api.php?action=query&list=allpages 可枚举全部页面
//   - 谱面页命名：「曲名 (难度)」，如 "天空の華 (EXT)"
//   - 页面带 "Notes: N (H)"，H = 长押条数（校验锚点，仅约 10% 页面有）
//
// 用法：
//   node scripts/fetch-mywiki-batch.mjs --list        枚举全部谱面页
//   node scripts/fetch-mywiki-batch.mjs --batch <n>   抓 n 个（断点续抓）
//   node scripts/fetch-mywiki-batch.mjs --status      查看进度
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fetchChart, safeName } from './fetch-text.mjs';

const OUT = path.join(process.cwd(), 'data', 'memo');
mkdirSync(OUT, { recursive: true });

const API = 'https://www.mywiki.cn/cosmosmemo/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jubeat-wiki-builder/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用 MediaWiki API 枚举全部谱面页 */
export async function listAllPages({ diffs = ['BSC', 'ADV', 'EXT'], onProgress } = {}) {
  const titles = [];
  let cont = null, guard = 0;
  do {
    const u = new URL(API);
    u.searchParams.set('action', 'query');
    u.searchParams.set('list', 'allpages');
    u.searchParams.set('aplimit', '500');
    u.searchParams.set('apnamespace', '0');
    u.searchParams.set('format', 'json');
    if (cont) u.searchParams.set('apcontinue', cont);

    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('allpages HTTP ' + r.status);
    const j = await r.json();
    for (const p of j.query?.allpages || []) titles.push(p.title);
    cont = j.continue?.apcontinue || null;
    if (onProgress) onProgress(titles.length);
    if (++guard > 40) break;
    await sleep(120);
  } while (cont);

  const re = new RegExp('\\s\\((' + diffs.join('|') + ')\\)$');
  return titles.filter((t) => re.test(t));
}

/** 标题 -> 输出文件名 */
export function fnFor(title) {
  const song = title.replace(/\s*\([^)]*\)$/, '').trim();
  const diff = (title.match(/\(([^)]+)\)$/) || [])[1] || '';
  return `${safeName(song)}-${diff}-mywiki.json`;
}

// ---------- CLI ----------
const isMain = process.argv[1] && process.argv[1].endsWith('fetch-mywiki-batch.mjs');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);

if (isMain) {
  if (has('--status')) {
    const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    const byDiff = {};
    let holds = 0, holdsDeclared = 0;
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(path.join(OUT, f), 'utf8'));
        byDiff[j.difficulty || '?'] = (byDiff[j.difficulty || '?'] || 0) + 1;
        holds += j.measuredHolds || 0;
        if (j.declaredHolds != null) holdsDeclared++;
      } catch { /* ignore */ }
    }
    console.log(`已抓 ${files.length} 个谱面`);
    console.log('按难度:', JSON.stringify(byDiff));
    console.log(`累计长押 ${holds}，其中 ${holdsDeclared} 个页面带 (H) 校验锚点`);
  } else if (has('--list')) {
    console.log('正在枚举全部谱面页…');
    const titles = await listAllPages({ onProgress: (n) => process.stdout.write('\r  已发现 ' + n + ' 页…') });
    console.log('\n共 ' + titles.length + ' 个谱面页');
    const byDiff = {};
    for (const t of titles) {
      const d = (t.match(/\(([^)]+)\)$/) || [])[1] || '?';
      byDiff[d] = (byDiff[d] || 0) + 1;
    }
    console.log('按难度:', JSON.stringify(byDiff));
    writeFileSync(path.join(OUT, '_titles.json'), JSON.stringify(titles, null, 1), 'utf8');
    console.log('-> data/memo/_titles.json');
  } else if (has('--batch')) {
    const n = parseInt(arg('--batch') || '20', 10);
    const titlesFile = path.join(OUT, '_titles.json');
    if (!existsSync(titlesFile)) {
      console.error('先跑 --list 生成清单');
      process.exitCode = 1;
    } else {
      const all = JSON.parse(readFileSync(titlesFile, 'utf8'));
      const todo = all.filter((t) => !existsSync(path.join(OUT, fnFor(t))));
      console.log(`清单 ${all.length}，未抓 ${todo.length}，本次抓 ${Math.min(n, todo.length)}`);
      if (!todo.length) { console.log('全部已抓完'); }
      else {
        const batch = todo.slice(0, n);
        let ok = 0, fail = 0, checked = 0, mism = 0;
        const badList = [];
        for (let i = 0; i < batch.length; i++) {
          const t = batch[i];
          try {
            const r = await fetchChart(t);
            if (!r.ok) { fail++; console.log(`  [${i + 1}/${batch.length}] SKIP ${t} — ${r.why}`); continue; }
            writeFileSync(path.join(OUT, r.fn), JSON.stringify(r.chart, null, 1), 'utf8');
            ok++;
            const d = r.chart;
            let tag = 'OK  ';
            if (d.declaredHolds != null) {
              checked++;
              if (d.measuredHolds !== d.declaredHolds) {
                mism++;
                tag = 'MISM';
                badList.push(`${r.fn}: ${d.measuredHolds}/${d.declaredHolds}`);
              }
            }
            if (tag === 'MISM' || i % 10 === 0) {
              console.log(`  [${i + 1}/${batch.length}] ${tag} ${r.fn}  小节=${d.measures.length} 长押=${d.measuredHolds}${d.declaredHolds != null ? '/' + d.declaredHolds : ''}`);
            }
          } catch (e) {
            fail++;
            console.log(`  [${i + 1}/${batch.length}] FAIL ${t} — ${e.message}`);
          }
          await sleep(250 + Math.random() * 350);
        }
        console.log(`\n成功 ${ok}，失败 ${fail}`);
        console.log(`带锚点的 ${checked} 个中，长押数不符 ${mism} 个`);
        for (const b of badList.slice(0, 15)) console.log('    ❌ ' + b);
      }
    }
  } else {
    console.log('mywiki.cn 批量抓取');
    console.log('  --list            枚举全部谱面页 -> data/memo/_titles.json');
    console.log('  --batch <n>       从清单抓 n 个（断点续抓）');
    console.log('  --status          查看进度');
  }
}
