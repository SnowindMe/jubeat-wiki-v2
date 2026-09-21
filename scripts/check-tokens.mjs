// Find var(--w-*) references with no matching definition: those declarations are
// silently dropped by the browser, which is how broken styles hide.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const css = readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
const defined = new Set([...css.matchAll(/(--w-[\w-]+)\s*:/g)].map(m => m[1]));

// set at runtime by markup (inline style) rather than declared in the stylesheet
const runtime = new Set(['--w-progress']);

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(astro|css|ts|mjs)$/.test(entry)) files.push(full);
  }
};
walk(path.join(root, 'src'));

const missing = new Map();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/var\((--w-[\w-]+)/g)) {
    if (defined.has(m[1]) || runtime.has(m[1])) continue;
    const rel = path.relative(root, file).replaceAll('\\', '/');
    if (!missing.has(m[1])) missing.set(m[1], new Set());
    missing.get(m[1]).add(rel);
  }
}

console.log(`defined tokens: ${defined.size}`);
if (missing.size === 0) console.log('OK: every var(--w-*) reference resolves');
else {
  console.log(`\nUNDEFINED references: ${missing.size}`);
  for (const [token, where] of missing) console.log(`  ${token}  <-  ${[...where].join(', ')}`);
  process.exit(1);
}
