export type Locale = "ru" | "uk" | "en";
export type PlaybackMode = "sequential" | "repeat" | "random";
export type Palette = "vivid" | "dark" | "light" | "ocean";
export type Appearance = "system" | "light" | "dark";
export type SourceKind = "vault-folder" | "vault-file" | "external-folder" | "external-file";
export type AudioFormat = "mp3" | "mpeg" | "wav" | "ogg" | "oga" | "opus" | "flac" | "m4a" | "m4b" | "mp4" | "aac" | "caf" | "weba" | "webm" | "ec3" | "eac3";
export type BuiltInCue = "chime" | "soft" | "pop" | "double" | "click" | "sonar" | "marimba" | "harp" | "notification" | "woodblock" | "complete" | "cashDrawer" | "fallingCoin" | "screenKnock" | "icqMessage" | "startupAurora" | "startupGlass" | "startupWelcome" | "startupRipple" | "startupOrbit" | "monkeySqueal";
export type ActionEvent = "task-completed" | "note-created" | "note-modified" | "note-renamed" | "manual-pattern" | "app-started";
export type HotkeyAction = "playPause" | "nextTrack" | "previousTrack" | "openPlayer";

export interface LibrarySource {
	id: string;
	kind: SourceKind;
	path: string;
	name: string;
	enabled: boolean;
}

export interface LocalTrack {
	id: string;
	kind: "local";
	path: string;
	title: string;
	displayTitle?: string;
	format: AudioFormat;
	sourceId: string;
	fileIdentity?: string;
}

export interface YouTubeTrack {
	id: string;
	kind: "youtube";
	videoId: string;
	title: string;
	displayTitle?: string;
}

export type PlayerTrack = LocalTrack | YouTubeTrack;

export interface Playlist {
	id: string;
	name: string;
	trackIds: string[];
}

export interface CollectionEntry {
	playlistId: string;
	enabled: boolean;
}

export interface PlaybackCollection {
	id: string;
	name: string;
	playlists: CollectionEntry[];
}

export interface TaskSoundRule {
	id: string;
	event: ActionEvent;
	path: string;
	preset?: BuiltInCue | null;
	enabled: boolean;
	pattern?: string;
}

export interface PluginSettings {
	version: number;
	locale: Locale;
	youtubeEnabled: boolean;
	autoSwitchToLastLocal: boolean;
	autoStart: boolean;
	scrollTitle: boolean;
	palette: Palette;
	appearance: Appearance;
	volume: number;
	playbackMode: PlaybackMode;
	queueSelection: string;
	sources: LibrarySource[];
	tracks: LocalTrack[];
	youtubeTracks: YouTubeTrack[];
	youtubePlaylistInitialized: boolean;
	excludedTrackIds: string[];
	playlists: Playlist[];
	collections: PlaybackCollection[];
	taskSoundRules: TaskSoundRule[];
	hotkeys: Record<HotkeyAction, string>;
	lastTrackId: string | null;
	lastLocalTrackId: string | null;
	guidePath: string | null;
	guideShown: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	version: 1,
	locale: "ru",
	youtubeEnabled: false,
	autoSwitchToLastLocal: false,
	autoStart: false,
	scrollTitle: false,
	palette: "vivid",
	appearance: "system",
	volume: 0.75,
	playbackMode: "sequential",
	queueSelection: "all",
	sources: [],
	tracks: [],
	youtubeTracks: [],
	youtubePlaylistInitialized: false,
	excludedTrackIds: [],
	playlists: [],
	collections: [],
	taskSoundRules: [],
	hotkeys: { playPause: "", nextTrack: "", previousTrack: "", openPlayer: "" },
	lastTrackId: null,
	lastLocalTrackId: null,
	guidePath: null,
	guideShown: false,
};
