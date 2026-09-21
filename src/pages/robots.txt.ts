export function GET() {
  return new Response('User-agent: *\nAllow: /\nSitemap: https://byd-ub.top/sitemap-index.xml\n', { headers: { 'Content-Type': 'text/plain' } });
}
