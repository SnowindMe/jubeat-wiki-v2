import songsData from '../../data/songs.json';
import jubilityData from '../../data/jubility.json';
import unlockData from '../../data/unlock.json';
import metaData from '../../data/data-meta.json';

export type Song = (typeof songsData.songs)[number];
export const songs = songsData.songs;
export const jubility = jubilityData;
export const unlock = unlockData;
export const meta = metaData;
export const diffLabels = { bsc: 'BASIC', adv: 'ADVANCED', ext: 'EXTREME' } as const;
export const display = (value: string | number | null | undefined, empty = '—') => value === null || value === undefined || value === '' ? empty : value;
export const songPathId = (songId: string) => /^\d+$/.test(songId) ? songId : `id-${Array.from(songId, char => char.codePointAt(0)!.toString(16)).join('-')}`;
export const songHref = (songId: string) => `/songs/${songPathId(songId)}/`;
export const sourceLabel = (source: string) => ({ api: '官方 API', remywiki: 'remywiki', 'remywiki.index': 'remywiki 索引', genesa: 'GENESA', xlsx3: '表 3', xlsx5: '表 5', all_songs: '官方曲库', 'cover-map': '曲绘映射' }[source] ?? source);
