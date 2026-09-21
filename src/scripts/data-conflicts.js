import raw from '../../data/data-conflicts.json';
export const conflicts = raw.conflicts;
export const conflictsForSong = (songId) => raw.fieldLevel.diffs.filter(item => item.songId === songId);
export const conflictMeta = raw;
