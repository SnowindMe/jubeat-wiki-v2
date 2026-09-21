// 临时静态服务器（验证用）：把 dist 目录挂在 http 上，供 headless Chrome 访问。
// 用法：node _serve.mjs [root] [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const ROOT = process.argv[2] || 'dist';
const PORT = Number(process.argv[3] || 8899);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // 验证页回传通道：把每次 log 的结果落盘，
    // 免得 headless Chrome 的 --virtual-time-budget 提前收工导致结果丢失。
    if (req.method === 'POST' && pathname === '/__e2e') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { writeFile } = await import('node:fs/promises');
      await writeFile('_e2e_out.txt', Buffer.concat(chunks).toString('utf8'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    let data;
    try {
      const st = await stat(file);
      data = st.isDirectory() ? await readFile(join(file, 'index.html')) : await readFile(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('500 ' + err.message);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
