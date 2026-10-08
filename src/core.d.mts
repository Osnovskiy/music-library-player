export declare const AUDIO_EXTENSIONS: readonly string[];
export declare const AUDIO_MIME_TYPES: Readonly<Record<string, readonly string[]>>;
export declare function getFullTrackTitle(track: { kind: "local"; title: string; path: string; displayTitle?: string } | { kind: "youtube"; title: string; displayTitle?: string }): string;
export declare function findRenamedTracks<T extends { id: string; fileIdentity?: string }>(previous: T[], discovered: T[]): Array<[T, T]>;

export declare function isAudioPath(filePath: string): boolean;
export declare function getAudioMimeType(filePath: string): string;
export declare function getSupportedAudioExtensions(canPlayType: (mimeType: string) => string): string[];
export declare function extractYoutubeId(rawUrl: string): string | null;
export declare function ensureYoutubePlaylist(playlists: Array<{ id: string; name: string; trackIds: string[] }>, youtubeTracks: ReadonlyArray<{ id: string }>, includeExisting?: boolean): { id: string; name: string; trackIds: string[] };
export declare function countCompletedTasks(markdown: string): number;
export declare function countNewCompletedTasks(previous: string, next: string): number;
export declare function matchesNewPattern(patternText: string, previous: string, next: string): boolean;
