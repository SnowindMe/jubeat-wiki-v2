import { songs, songHref } from '../lib/data';

export function GET() {
  const entries = songs.map(({ songId, title, artist }) => ({ songId, title, artist, url: songHref(songId) }));
  return new Response(JSON.stringify({ version: 1, generatedFrom: 'data/songs.json', entries }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}
