import {
	ItemView,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	requestUrl,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BigIntStats } from "node:fs";
import { AUDIO_EXTENSIONS, countNewCompletedTasks, ensureYoutubePlaylist, extractYoutubeId, findRenamedTracks, getAudioMimeType, getFullTrackTitle, getSupportedAudioExtensions, isAudioPath, matchesNewPattern } from "./core.mjs";
import { MusicPlayerSettingTab } from "./settings";
import { t } from "./i18n";
import { GUIDE_PATH, VIEW_TYPE_MUSIC_PLAYER } from "./constants";
import type {
	ActionEvent,
	AudioFormat,
	LibrarySource,
	LocalTrack,
	PlaybackCollection,
	PlaybackMode,
	PluginSettings,
	Playlist,
	PlayerTrack,
	TaskSoundRule,
	YouTubeTrack,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { MusicPlayerView, PlaylistSuggestModal, TrackInfoModal, VaultAudioSuggestModal } from "./view";
import { shortcutFromEvent } from "./hotkeys";

interface OpenDialogResult {
	canceled: boolean;
	filePaths: string[];
}

interface NativeDialog {
	showOpenDialog(options: Record<string, unknown>): Promise<OpenDialogResult>;
}

interface NativeShell {
	showItemInFolder(path: string): void;
}

interface ElectronWebUtils {
	getPathForFile?(file: File): string;
}

interface YoutubePlayer {
	playVideo(): void;
	pauseVideo(): void;
	stopVideo(): void;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	getCurrentTime(): number;
	getDuration(): number;
	getVideoData?(): { title?: string; video_id?: string };
	cueVideoById(videoId: string): void;
	loadVideoById(videoId: string): void;
	setVolume(volume: number): void;
	destroy(): void;
}

interface YoutubeApi {
	PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number };
	Player: new (elementId: string, options: Record<string, unknown>) => YoutubePlayer;
}

declare global {
	interface Window {
		YT?: YoutubeApi;
		onYouTubeIframeAPIReady?: () => void;
	}
}

export default class MusicPlayerPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	view: MusicPlayerView | null = null;
	currentTrackId: string | null = null;
	isPlaying = false;
	isYoutubePlaying = false;
	audio: HTMLAudioElement | null = null;
	taskAudio: HTMLAudioElement | null = null;
	youtubePlayer: YoutubePlayer | null = null;
	private youtubeApiPromise: Promise<YoutubeApi> | null = null;
	private youtubeTitleRequests = new Map<string, Promise<void>>();
	private youtubeLoadedTrackId: string | null = null;
	private youtubePlayerReady = false;
	private pendingYoutubeAutoplayId: string | null = null;
	private youtubePreviewRequestId = 0;
	private youtubePreviewClosed = false;
	private audioObjectUrl: string | null = null;
	private audioTrackId: string | null = null;
	private playbackRequestId = 0;
	private taskSoundContext: AudioContext | null = null;
	private taskSoundNodes: AudioScheduledSourceNode[] = [];
	private taskSoundGain: GainNode | null = null;
	private effectBuffers = new Map<string, AudioBuffer>();
	private statusBarButton: HTMLButtonElement | null = null;
	private taskSoundRequestId = 0;
	private pendingTaskCompletionClicks: number[] = [];
	private taskSoundObjectUrl: string | null = null;
	private markdownUpdateQueue = new Map<string, Promise<void>>();
	private isUnloading = false;
	private markdownSnapshots = new Map<string, string>();
	private randomHistory: string[] = [];
	private randomHistoryIndex = -1;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.currentTrackId = this.settings.lastTrackId;
		this.registerView(VIEW_TYPE_MUSIC_PLAYER, (leaf) => new MusicPlayerView(leaf, this));
		this.addSettingTab(new MusicPlayerSettingTab(this.app, this));
		this.addRibbonIcon("audio-lines", t(this.settings.locale, "openPlayer"), () => void this.openPlayer());
		this.addCommand({ id: "open-player", name: t(this.settings.locale, "openPlayer"), callback: () => void this.openPlayer() });
		this.addCommand({ id: "play-pause", name: "Play or pause", callback: () => void this.togglePlayback() });
		this.addCommand({ id: "previous-track", name: "Previous track", callback: () => void this.previousTrack() });
		this.addCommand({ id: "next-track", name: "Next track", callback: () => void this.nextTrack() });
		this.addCommand({ id: "stop", name: "Stop playback", callback: () => this.stopPlayback() });
		const statusItem = this.addStatusBarItem();
		statusItem.addClass("mlp-statusbar");
		this.statusBarButton = statusItem.createEl("button", { cls: "mlp-statusbar-button", attr: { type: "button" } });
		this.statusBarButton.addEventListener("click", () => void this.togglePlayback());
		this.refreshStatusBar();
		this.audio = new Audio();
		this.audio.volume = this.settings.volume;
		this.audio.addEventListener("play", () => {
			this.isPlaying = true;
			this.isYoutubePlaying = false;
			if (this.currentTrackId) {
				const track = this.getTrack(this.currentTrackId);
				if (track?.kind === "local") this.settings.lastLocalTrackId = track.id;
				this.settings.lastTrackId = this.currentTrackId;
			}
			this.syncView();
			void this.saveSettings();
		});
		this.audio.addEventListener("pause", () => {
			if (!this.isYoutubePlaying) this.isPlaying = false;
			this.syncView();
		});
		this.audio.addEventListener("ended", () => void this.advanceAfterCurrent());
		this.audio.addEventListener("error", () => {
			const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
			if (track?.kind === "local") {
				this.isPlaying = false;
				this.syncView();
				new Notice(t(this.settings.locale, "trackUnavailable", { path: track.path }));
			}
		});
		const unlockTaskAudio = () => {
			try {
				this.taskSoundContext ??= new AudioContext();
				if (this.taskSoundContext.state === "suspended") void this.taskSoundContext.resume().catch(() => undefined);
			} catch (error) {
				console.warn("Music Library Player: audio could not be unlocked", error);
			}
		};
		this.registerDomEvent(document, "touchstart", unlockTaskAudio, true);
		this.registerDomEvent(document, "touchend", unlockTaskAudio, true);
		this.registerDomEvent(document, "click", unlockTaskAudio, true);
		this.registerDomEvent(document, "keydown", unlockTaskAudio, true);
		this.registerDomEvent(document, "keydown", (event) => this.onHotkeyPressed(event), true);
		this.registerDomEvent(document, "change", (event) => this.onTaskCheckboxChanged(event), true);

		this.registerDomEvent(window, "online", () => this.view?.render());
		this.registerDomEvent(window, "offline", () => {
			this.view?.render();
			if (this.getTrack(this.currentTrackId ?? "")?.kind === "youtube") void this.handleYoutubeFailure();
		});
		this.app.workspace.onLayoutReady(() => {
			this.playActionSound("app-started");
			void this.registerVaultEvents();
			void this.createAndShowGuideOnce();
			if (this.settings.autoStart && this.settings.lastTrackId) {
				window.setTimeout(() => void this.playTrack(this.settings.lastTrackId!), 500);
			}
		});
	}

	onunload(): void {
		this.isUnloading = true;
		this.taskSoundRequestId += 1;
		this.youtubePreviewRequestId += 1;
		this.audio?.pause();
		this.audio?.removeAttribute("src");
		this.audio?.load();
		this.revokeAudioObjectUrl();
		this.taskAudio?.pause();
		this.stopTaskCue();
		void this.taskSoundContext?.close().catch(() => undefined);
		this.youtubePlayer?.stopVideo();
		this.youtubePlayer?.destroy();
		this.youtubeLoadedTrackId = null;
		this.youtubePlayerReady = false;
	}

	tr(key: Parameters<typeof t>[1], values?: Record<string, string | number>): string {
		return t(this.settings.locale, key, values);
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(saved ?? {}),
			sources: saved?.sources ?? [],
			tracks: saved?.tracks ?? [],
			youtubeTracks: saved?.youtubeTracks ?? [],
			excludedTrackIds: saved?.excludedTrackIds ?? [],
			playlists: saved?.playlists ?? [],
			collections: saved?.collections ?? [],
			taskSoundRules: saved?.taskSoundRules ?? [],
			hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(saved?.hotkeys ?? {}) },
		};
		for (const rule of this.settings.taskSoundRules) {
			if (rule.preset === undefined) rule.preset = null;
			const replacements: Record<string, NonNullable<TaskSoundRule["preset"]>> = {
				bell: "cashDrawer", coin: "fallingCoin", alert: "screenKnock", sparkle: "icqMessage", success: "complete",
			};
			if (rule.preset && replacements[rule.preset]) rule.preset = replacements[rule.preset];
		}
		if (!this.settings.youtubePlaylistInitialized) {
			ensureYoutubePlaylist(this.settings.playlists, this.settings.youtubeTracks, true);
			this.settings.youtubePlaylistInitialized = true;
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		this.settings.lastTrackId = this.currentTrackId;
		await this.saveData(this.settings);
	}

	private async persistAndRender(): Promise<void> {
		await this.saveData(this.settings);
		this.view?.render();
	}

	async openPlayer(): Promise<void> {
		let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE_MUSIC_PLAYER)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_MUSIC_PLAYER, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	getTrack(id: string): PlayerTrack | undefined {
		return this.settings.tracks.find((track) => track.id === id)
			?? this.settings.youtubeTracks.find((track) => track.id === id);
	}

	getDisplayTitle(track: PlayerTrack): string {
		return getFullTrackTitle(track);
	}

	async renameTrack(trackId: string, newTitle: string): Promise<void> {
		const track = this.getTrack(trackId);
		const title = newTitle.trim();
		if (!track || !title || title === this.getDisplayTitle(track)) return;
		track.displayTitle = title;
		track.title = title;
		if (track.kind === "youtube") this.view?.setYoutubeLabel(title);
		await this.persistAndRender();
		new Notice(this.tr("trackRenamed"));
	}

	getQueue(): PlayerTrack[] {
		const trackMap = new Map<string, PlayerTrack>();
		for (const track of this.settings.tracks) trackMap.set(track.id, track);
		if (this.settings.youtubeEnabled && navigator.onLine) {
			for (const track of this.settings.youtubeTracks) trackMap.set(track.id, track);
		}

		if (this.settings.queueSelection.startsWith("playlist:")) {
			const playlist = this.settings.playlists.find((item) => item.id === this.settings.queueSelection.slice(9));
			return (playlist?.trackIds ?? []).map((id) => trackMap.get(id)).filter((item): item is PlayerTrack => !!item);
		}
		if (this.settings.queueSelection.startsWith("collection:")) {
			const collection = this.settings.collections.find((item) => item.id === this.settings.queueSelection.slice(11));
			const ids = (collection?.playlists ?? []).filter((entry) => entry.enabled)
				.flatMap((entry) => this.settings.playlists.find((p) => p.id === entry.playlistId)?.trackIds ?? []);
			return ids.map((id) => trackMap.get(id)).filter((item): item is PlayerTrack => !!item);
		}
		return [...this.settings.tracks, ...(this.settings.youtubeEnabled && navigator.onLine ? this.settings.youtubeTracks : [])];
	}

	getLocalTracks(): LocalTrack[] {
		return this.settings.tracks;
	}

	async setQueueSelection(value: string): Promise<void> {
		this.settings.queueSelection = value;
		if (this.currentTrackId && !this.getQueue().some((track) => track.id === this.currentTrackId)) this.stopPlayback();
		await this.persistAndRender();
	}

	async setPlaybackMode(mode: PlaybackMode): Promise<void> {
		this.settings.playbackMode = mode;
		await this.persistAndRender();
	}

	async setVolume(value: number): Promise<void> {
		this.settings.volume = Math.max(0, Math.min(1, value));
		if (this.audio) this.audio.volume = this.settings.volume;
		this.youtubePlayer?.setVolume(Math.round(this.settings.volume * 100));
		await this.saveData(this.settings);
	}

	getPlaybackProgress(): { elapsed: number; duration: number } {
		const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
		let elapsed = 0;
		let duration = 0;
		if (track?.kind === "local" && this.audioTrackId === track.id && this.audio) {
			elapsed = this.audio.currentTime;
			duration = this.audio.duration;
		} else if (track?.kind === "youtube" && this.youtubeLoadedTrackId === track.id && this.youtubePlayerReady && this.youtubePlayer) {
			try {
				elapsed = this.youtubePlayer.getCurrentTime();
				duration = this.youtubePlayer.getDuration();
			} catch { /* The iframe may be closing or loading a new video. */ }
		}
		if (!Number.isFinite(duration) || duration <= 0) return { elapsed: 0, duration: 0 };
		return { elapsed: Math.max(0, Math.min(duration, Number.isFinite(elapsed) ? elapsed : 0)), duration };
	}

	seekPlayback(seconds: number): void {
		const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
		const { duration } = this.getPlaybackProgress();
		if (!track || duration <= 0 || !Number.isFinite(seconds)) return;
		const target = Math.max(0, Math.min(duration, seconds));
		try {
			if (track.kind === "youtube" && this.youtubeLoadedTrackId === track.id && this.youtubePlayerReady) this.youtubePlayer?.seekTo(target, true);
			else if (track.kind === "local" && this.audioTrackId === track.id && this.audio) this.audio.currentTime = target;
		} catch (error) {
			console.warn("Music Library Player: could not seek", error);
		}
		this.view?.renderProgress();
	}

	async toggleYoutube(enabled: boolean): Promise<void> {
		this.settings.youtubeEnabled = enabled;
		if (!enabled) {
			this.youtubePreviewRequestId += 1;
			if (this.currentTrackId && this.getTrack(this.currentTrackId)?.kind === "youtube") {
				this.youtubePlayer?.stopVideo();
				this.isYoutubePlaying = false;
				this.isPlaying = false;
				const fallback = this.findLastLocalInQueue();
				if (fallback) void this.playTrack(fallback.id);
				else {
					this.currentTrackId = null;
					this.settings.lastTrackId = null;
				}
			}
			this.youtubePlayer?.destroy();
			this.youtubePlayer = null;
			this.youtubeLoadedTrackId = null;
			this.youtubePlayerReady = false;
			this.pendingYoutubeAutoplayId = null;
			this.youtubeApiPromise = null;
		}
		await this.persistAndRender();
	}

	async addYoutubeLink(rawUrl: string): Promise<boolean> {
		if (!this.settings.youtubeEnabled) {
			new Notice(this.tr("youtubeOff"));
			return false;
		}
		if (!navigator.onLine) {
			new Notice(this.tr("youtubeOffline"));
			return false;
		}
		const videoId = extractYoutubeId(rawUrl.trim());
		if (!videoId) {
			new Notice(this.tr("invalidYoutube"));
			return false;
		}
		const id = `youtube:${videoId}`;
		const playlist = ensureYoutubePlaylist(this.settings.playlists, this.settings.youtubeTracks);
		let track = this.settings.youtubeTracks.find((item) => item.id === id);
		if (track && playlist.trackIds.includes(id)) {
			new Notice(this.tr("youtubeAlreadyAdded"));
			return false;
		}
		if (!track) {
			track = { id, kind: "youtube", videoId, title: "YouTube" };
			this.settings.youtubeTracks.push(track);
		}
		if (!playlist.trackIds.includes(id)) playlist.trackIds.push(id);
		if (!this.isPlaying && !this.isYoutubePlaying) {
			this.settings.queueSelection = `playlist:${playlist.id}`;
			if (this.currentTrackId && !this.getQueue().some((item) => item.id === this.currentTrackId)) this.stopPlayback();
		}
		await this.persistAndRender();
		new Notice(this.tr("youtubeAddedToPlaylist"));
		void this.resolveYoutubeTitle(track);
		return true;
	}

	refreshYoutubeTitle(track: YouTubeTrack): void {
		void this.resolveYoutubeTitle(track);
	}

	private resolveYoutubeTitle(track: YouTubeTrack): Promise<void> {
		if (!this.settings.youtubeEnabled || !navigator.onLine || (track.title !== "YouTube" && track.title !== `YouTube ${track.videoId}` && !track.title.endsWith("…"))) return Promise.resolve();
		const pending = this.youtubeTitleRequests.get(track.id);
		if (pending) return pending;
		const request = (async () => {
			try {
				const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(track.videoId)}`;
				const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
				const response = await requestUrl({ url, throw: false });
				if (response.status !== 200) return;
				const metadata = response.json as { title?: unknown };
				const title = typeof metadata?.title === "string" ? metadata.title.trim() : "";
				await this.saveResolvedYoutubeTitle(track, title);
			} catch (error) {
				console.warn("Music Library Player: YouTube title lookup failed", error);
			}
		})();
		this.youtubeTitleRequests.set(track.id, request);
		void request.finally(() => this.youtubeTitleRequests.delete(track.id));
		return request;
	}

	private async saveResolvedYoutubeTitle(track: YouTubeTrack, title: string): Promise<void> {
		const cleanTitle = title.trim();
		if (!cleanTitle || track.displayTitle || track.title === cleanTitle || this.isUnloading || !this.settings.youtubeTracks.includes(track)) return;
		track.title = cleanTitle;
		await this.saveSettings();
		this.view?.render();
		if (this.youtubeLoadedTrackId === track.id) this.view?.updateYoutubeLabel(cleanTitle);
	}

	async addPlaylist(name: string): Promise<void> {
		const playlist: Playlist = { id: this.newId("playlist"), name: name.trim(), trackIds: [] };
		this.settings.playlists.push(playlist);
		this.settings.queueSelection = `playlist:${playlist.id}`;
		new Notice(this.tr("playlistCreated"));
		await this.persistAndRender();
	}

	async addCollection(name: string): Promise<void> {
		const collection: PlaybackCollection = { id: this.newId("collection"), name: name.trim(), playlists: [] };
		this.settings.collections.push(collection);
		this.settings.queueSelection = `collection:${collection.id}`;
		new Notice(this.tr("collectionCreated"));
		await this.persistAndRender();
	}

	async addTrackToPlaylist(trackId: string, playlist: Playlist): Promise<void> {
		if (!playlist.trackIds.includes(trackId)) playlist.trackIds.push(trackId);
		await this.persistAndRender();
		new Notice(this.tr("trackAddedToPlaylist"));
	}

	async removeTrackFromPlaylist(trackId: string, playlist: Playlist): Promise<void> {
		playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
		await this.persistAndRender();
		new Notice(this.tr("trackRemovedFromPlaylist"));
	}

	async addPlaylistToCollection(collection: PlaybackCollection, playlist: Playlist): Promise<void> {
		if (collection.playlists.some((entry) => entry.playlistId === playlist.id)) {
			new Notice(this.tr("playlistAlreadyInCollection"));
			return;
		}
		collection.playlists.push({ playlistId: playlist.id, enabled: true });
		await this.persistAndRender();
	}

	async setCollectionPlaylistEnabled(collection: PlaybackCollection, playlistId: string, enabled: boolean): Promise<void> {
		const item = collection.playlists.find((entry) => entry.playlistId === playlistId);
		if (item) item.enabled = enabled;
		if (this.currentTrackId && !this.getQueue().some((track) => track.id === this.currentTrackId)) this.stopPlayback();
		await this.persistAndRender();
	}

	async deletePlaylist(playlistId: string): Promise<void> {
		this.settings.playlists = this.settings.playlists.filter((item) => item.id !== playlistId);
		for (const collection of this.settings.collections) collection.playlists = collection.playlists.filter((item) => item.playlistId !== playlistId);
		if (this.settings.queueSelection === `playlist:${playlistId}`) this.settings.queueSelection = "all";
		await this.persistAndRender();
	}

	async deleteCollection(collectionId: string): Promise<void> {
		this.settings.collections = this.settings.collections.filter((item) => item.id !== collectionId);
		if (this.settings.queueSelection === `collection:${collectionId}`) this.settings.queueSelection = "all";
		await this.persistAndRender();
	}

	async removeTrack(track: PlayerTrack): Promise<void> {
		if (track.kind === "youtube") {
			this.settings.youtubeTracks = this.settings.youtubeTracks.filter((item) => item.id !== track.id);
		} else {
			this.settings.tracks = this.settings.tracks.filter((item) => item.id !== track.id);
			this.settings.excludedTrackIds.push(track.id);
		}
		for (const playlist of this.settings.playlists) playlist.trackIds = playlist.trackIds.filter((id) => id !== track.id);
		if (this.currentTrackId === track.id) this.stopPlayback();
		await this.persistAndRender();
		new Notice(this.tr(track.kind === "youtube" ? "removeLink" : "trackRemoved"));
	}

	async addExternalFiles(filePaths: string[]): Promise<void> {
		for (const filePath of filePaths) {
			if (!this.isAudioPath(filePath)) continue;
			const absolutePath = path.resolve(filePath);
			const stat = await fs.stat(absolutePath, { bigint: true });
			const id = `external:${absolutePath}`;
			const sourceId = `external-file:${absolutePath}`;
			this.upsertSource({ id: sourceId, kind: "external-file", path: absolutePath, name: path.basename(absolutePath), enabled: true });
			this.settings.excludedTrackIds = this.settings.excludedTrackIds.filter((excluded) => excluded !== id);
			this.upsertLocalTrack({ id, kind: "local", path: absolutePath, title: path.basename(absolutePath, path.extname(absolutePath)), format: this.formatForPath(absolutePath), sourceId, fileIdentity: this.fileIdentity(stat) });
		}
		await this.persistAndRender();
		new Notice(this.tr("trackAdded"));
	}

	async addExternalFolder(folderPath: string): Promise<void> {
		const absolutePath = path.resolve(folderPath);
		this.upsertSource({ id: `external-folder:${absolutePath}`, kind: "external-folder", path: absolutePath, name: path.basename(absolutePath) || absolutePath, enabled: true });
		await this.reindexSources();
	}

	async addExternalFolderToPlaylist(folderPath: string, playlist: Playlist): Promise<void> {
		const absolutePath = path.resolve(folderPath);
		const sourceId = `external-folder:${absolutePath}`;
		const sourceName = path.basename(absolutePath) || absolutePath;
		this.upsertSource({ id: sourceId, kind: "external-folder", path: absolutePath, name: sourceName, enabled: true });
		await this.reindexSources(false);
		await this.addFolderTracksToPlaylist(sourceId, sourceName, playlist);
	}

	async addVaultFolder(folder: TFolder): Promise<void> {
		this.upsertSource({ id: `vault-folder:${folder.path}`, kind: "vault-folder", path: folder.path, name: folder.name || folder.path, enabled: true });
		await this.reindexSources();
	}

	async addVaultFolderToPlaylist(folder: TFolder, playlist: Playlist): Promise<void> {
		const sourceId = `vault-folder:${folder.path}`;
		const sourceName = folder.name || folder.path;
		this.upsertSource({ id: sourceId, kind: "vault-folder", path: folder.path, name: sourceName, enabled: true });
		await this.reindexSources(false);
		await this.addFolderTracksToPlaylist(sourceId, sourceName, playlist);
	}

	private async addFolderTracksToPlaylist(sourceId: string, sourceName: string, playlist: Playlist): Promise<void> {
		const trackIds = this.settings.tracks.filter((track) => track.sourceId === sourceId).map((track) => track.id);
		const existing = new Set(playlist.trackIds);
		const added = trackIds.filter((id) => !existing.has(id));
		playlist.trackIds.push(...added);
		await this.persistAndRender();
		new Notice(this.tr("folderTracksAdded", { count: added.length, name: sourceName, playlist: playlist.name }));
	}

	async addVaultFile(file: TFile): Promise<void> {
		if (!this.isAudioPath(file.path)) return;
		const sourceId = `vault-file:${file.path}`;
		const source: LibrarySource = { id: sourceId, kind: "vault-file", path: file.path, name: file.name, enabled: true };
		this.upsertSource(source);
		const track: LocalTrack = { id: `vault:${file.path}`, kind: "local", path: file.path, title: file.basename, format: this.formatForPath(file.path), sourceId };
		this.settings.excludedTrackIds = this.settings.excludedTrackIds.filter((excluded) => excluded !== track.id);
		this.upsertLocalTrack(track);
		await this.persistAndRender();
		new Notice(this.tr("trackAdded"));
	}

	private upsertSource(source: LibrarySource): void {
		const index = this.settings.sources.findIndex((item) => item.id === source.id);
		if (index >= 0) this.settings.sources[index] = source;
		else this.settings.sources.push(source);
	}

	private upsertLocalTrack(track: LocalTrack): void {
		const index = this.settings.tracks.findIndex((item) => item.id === track.id);
		if (index >= 0) {
			if (!track.displayTitle) track.displayTitle = this.settings.tracks[index].displayTitle;
			this.settings.tracks[index] = track;
		}
		else this.settings.tracks.push(track);
	}

	private fileIdentity(stat: { dev: bigint; ino: bigint }): string | undefined {
		return stat.ino === 0n ? undefined : `${stat.dev}:${stat.ino}`;
	}

	private replaceTrackReferences(oldId: string, newTrack: LocalTrack): void {
		for (const playlist of this.settings.playlists) {
			if (!playlist.trackIds.includes(oldId)) continue;
			playlist.trackIds = [...new Set(playlist.trackIds.map((id) => id === oldId ? newTrack.id : id))];
		}
		if (this.currentTrackId === oldId) this.currentTrackId = newTrack.id;
		if (this.audioTrackId === oldId) this.audioTrackId = newTrack.id;
		if (this.settings.lastTrackId === oldId) this.settings.lastTrackId = newTrack.id;
		if (this.settings.lastLocalTrackId === oldId) this.settings.lastLocalTrackId = newTrack.id;
		this.randomHistory = this.randomHistory.map((id) => id === oldId ? newTrack.id : id);
	}

	async removeSource(sourceId: string): Promise<void> {
		const removedTrackIds = this.settings.tracks.filter((track) => track.sourceId === sourceId).map((track) => track.id);
		if (this.currentTrackId && removedTrackIds.includes(this.currentTrackId)) this.stopPlayback();
		this.settings.sources = this.settings.sources.filter((source) => source.id !== sourceId);
		this.settings.tracks = this.settings.tracks.filter((track) => track.sourceId !== sourceId);
		this.settings.excludedTrackIds = this.settings.excludedTrackIds.filter((id) => !removedTrackIds.includes(id));
		for (const playlist of this.settings.playlists) playlist.trackIds = playlist.trackIds.filter((id) => !removedTrackIds.includes(id));
		await this.persistAndRender();
	}

	async reindexSources(showCompleteNotice = true): Promise<void> {
		let found = 0;
		for (const source of this.settings.sources.filter((item) => item.enabled)) {
			const sourceTracks = new Map<string, LocalTrack>();
			const previousSourceTracks = this.settings.tracks.filter((track) => track.sourceId === source.id);
			try {
				if (source.kind === "vault-folder") {
					const prefix = source.path ? `${source.path}/` : "";
					for (const file of this.app.vault.getFiles()) {
						if ((!source.path || file.path.startsWith(prefix)) && this.isAudioPath(file.path)) {
							const track: LocalTrack = { id: `vault:${file.path}`, kind: "local", path: file.path, title: file.basename, format: this.formatForPath(file.path), sourceId: source.id };
							if (!this.settings.excludedTrackIds.includes(track.id)) sourceTracks.set(track.id, track);
						}
					}
				} else if (source.kind === "vault-file") {
					const file = this.app.vault.getAbstractFileByPath(source.path);
					if (file instanceof TFile && this.isAudioPath(file.path)) {
						const track: LocalTrack = { id: `vault:${file.path}`, kind: "local", path: file.path, title: file.basename, format: this.formatForPath(file.path), sourceId: source.id };
						if (!this.settings.excludedTrackIds.includes(track.id)) sourceTracks.set(track.id, track);
					}
				} else if (source.kind === "external-file") {
					let filePath = source.path;
					let stat;
					try {
						stat = await fs.stat(filePath, { bigint: true });
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						const oldIdentity = previousSourceTracks.find((track) => track.fileIdentity)?.fileIdentity;
						if (code !== "ENOENT" || !oldIdentity) throw error;
						const siblings = await fs.readdir(path.dirname(filePath), { withFileTypes: true });
						const matches: Array<{ path: string; stat: BigIntStats }> = [];
						for (const sibling of siblings) {
							if (!sibling.isFile()) continue;
							const candidatePath = path.join(path.dirname(filePath), sibling.name);
							if (!this.isAudioPath(candidatePath)) continue;
							const candidateStat = await fs.stat(candidatePath, { bigint: true });
							if (this.fileIdentity(candidateStat) === oldIdentity) matches.push({ path: candidatePath, stat: candidateStat });
						}
						if (matches.length !== 1) throw error;
						filePath = matches[0].path;
						stat = matches[0].stat;
						source.path = filePath;
						source.name = path.basename(filePath);
					}
					if (this.isAudioPath(filePath)) {
						const track: LocalTrack = { id: `external:${path.resolve(filePath)}`, kind: "local", path: path.resolve(filePath), title: path.basename(filePath, path.extname(filePath)), format: this.formatForPath(filePath), sourceId: source.id, fileIdentity: this.fileIdentity(stat) };
						if (!this.settings.excludedTrackIds.includes(track.id)) sourceTracks.set(track.id, track);
					}
				} else {
					const files = await this.walkAudioFiles(source.path);
					for (const filePath of files) {
						const absolutePath = path.resolve(filePath);
						const id = `external:${absolutePath}`;
						if (this.settings.excludedTrackIds.includes(id)) continue;
						const stat = await fs.stat(absolutePath, { bigint: true });
						const track: LocalTrack = { id, kind: "local", path: absolutePath, title: path.basename(absolutePath, path.extname(absolutePath)), format: this.formatForPath(absolutePath), sourceId: source.id, fileIdentity: this.fileIdentity(stat) };
						sourceTracks.set(id, track);
					}
				}
				for (const [oldTrack, newTrack] of findRenamedTracks(previousSourceTracks, [...sourceTracks.values()])) {
					if (oldTrack.displayTitle) {
						newTrack.displayTitle = oldTrack.displayTitle;
						newTrack.title = oldTrack.displayTitle;
					}
					this.replaceTrackReferences(oldTrack.id, newTrack);
				}
				this.settings.tracks = this.settings.tracks.filter((track) => track.sourceId !== source.id || sourceTracks.has(track.id));
				for (const track of sourceTracks.values()) this.upsertLocalTrack(track);
				found += sourceTracks.size;
			} catch (error) {
				console.error("Music Library Player: source indexing failed", source.path, error);
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") this.removeTracksForMissingSource(source.id);
				new Notice(this.tr("indexFailed", { name: source.name }));
			}
		}
		await this.persistAndRender();
		if (showCompleteNotice) new Notice(this.tr("indexComplete", { count: found }));
	}

	private removeTracksForMissingSource(sourceId: string): void {
		const removedIds = this.settings.tracks.filter((track) => track.sourceId === sourceId).map((track) => track.id);
		if (this.currentTrackId && removedIds.includes(this.currentTrackId)) this.stopPlayback();
		this.settings.tracks = this.settings.tracks.filter((track) => track.sourceId !== sourceId);
	}

	private async walkAudioFiles(root: string): Promise<string[]> {
		const result: string[] = [];
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			const target = path.join(root, entry.name);
			if (entry.isDirectory()) result.push(...await this.walkAudioFiles(target));
			else if (entry.isFile() && this.isAudioPath(target)) result.push(target);
		}
		return result;
	}

	private isAudioPath(filePath: string): boolean {
		return isAudioPath(filePath);
	}

	private formatForPath(filePath: string): AudioFormat {
		return path.extname(filePath).slice(1).toLowerCase() as AudioFormat;
	}

	async openFileDialog(): Promise<string[]> {
		if (!Platform.isDesktopApp) return [];
		const dialog = this.getNativeDialog();
		const audioProbe = document.createElement("audio");
		const supportedExtensions = getSupportedAudioExtensions((mimeType) => audioProbe.canPlayType(mimeType));
		if (dialog) {
			try {
				const result = await dialog.showOpenDialog({
					properties: ["openFile", "multiSelections"],
					filters: [{ name: "Audio", extensions: supportedExtensions.length ? supportedExtensions : [...AUDIO_EXTENSIONS] }],
				});
				if (!result.canceled) return result.filePaths;
				return [];
			} catch (error) {
				console.warn("Music Library Player: native file dialog failed; trying the desktop file input", error);
			}
		}
		const files = await this.openDesktopFileInput(false);
		return this.pathsFromSelectedFiles(files);
	}

	async openFolderDialog(): Promise<string | null> {
		if (!Platform.isDesktopApp) return null;
		const dialog = this.getNativeDialog();
		if (dialog) {
			try {
				const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
				if (!result.canceled) return result.filePaths[0] ?? null;
				return null;
			} catch (error) {
				console.warn("Music Library Player: native folder dialog failed; trying the desktop folder input", error);
			}
		}
		const files = await this.openDesktopFileInput(true);
		if (!files.length) return null;
		const filePath = this.getPathForFile(files[0]);
		if (!filePath) {
			new Notice(this.tr("filePathUnavailable"));
			return null;
		}
		const relativePath = files[0].webkitRelativePath;
		const parentLevels = Math.max(0, relativePath.split(/[\\/]/).filter(Boolean).length - 2);
		return path.resolve(path.dirname(filePath), ...Array.from({ length: parentLevels }, () => ".."));
	}

	private openDesktopFileInput(directory: boolean): Promise<File[]> {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.multiple = true;
			input.accept = AUDIO_EXTENSIONS.map((extension) => `.${extension}`).join(",");
			if (directory) input.setAttribute("webkitdirectory", "");
			input.setAttribute("aria-hidden", "true");
			Object.assign(input.style, { position: "fixed", left: "-10000px", top: "0", opacity: "0" });
			let settled = false;
			const finish = (files: File[]) => {
				if (settled) return;
				settled = true;
				input.remove();
				resolve(files);
			};
			input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
			input.addEventListener("cancel", () => finish([]), { once: true });
			document.body.appendChild(input);
			input.click();
		});
	}

	private pathsFromSelectedFiles(files: File[]): string[] {
		const audioFiles = files.filter((file) => this.isAudioPath(file.name));
		const paths = audioFiles.map((file) => this.getPathForFile(file)).filter((filePath): filePath is string => !!filePath);
		if (audioFiles.length && paths.length !== audioFiles.length) new Notice(this.tr("filePathUnavailable"));
		return paths;
	}

	private getPathForFile(file: File): string | null {
		try {
			const electron = require("electron") as { webUtils?: ElectronWebUtils };
			const nativePath = electron.webUtils?.getPathForFile?.(file);
			if (nativePath) return nativePath;
		} catch { /* Older Obsidian builds may not expose Electron webUtils. */ }
		const legacyPath = (file as File & { path?: string }).path;
		return typeof legacyPath === "string" && legacyPath ? legacyPath : null;
	}

	private getNativeDialog(): NativeDialog | null {
		try {
			const electron = require("electron") as { remote?: { dialog?: NativeDialog } };
			if (electron.remote?.dialog) return electron.remote.dialog;
		} catch { /* continue to the supported remote bridge */ }
		try {
			const remote = require("@electron/remote") as { dialog?: NativeDialog };
			return remote.dialog ?? null;
		} catch {
			return null;
		}
	}

	async revealLocalTrack(track: LocalTrack): Promise<void> {
		try {
			const source = this.settings.sources.find((item) => item.id === track.sourceId);
			const fullPath = source?.kind.startsWith("vault-")
				? this.app.vault.adapter instanceof FileSystemAdapter ? this.app.vault.adapter.getFullPath(track.path) : null
				: track.path;
			if (!fullPath) throw new Error("Vault does not expose a filesystem path");
			await fs.access(fullPath);
			let shell: NativeShell | undefined;
			try { shell = (require("electron") as { shell?: NativeShell }).shell; } catch { /* use remote bridge */ }
			if (!shell) shell = (require("@electron/remote") as { shell?: NativeShell }).shell;
			if (!shell) throw new Error("File manager integration is unavailable");
			shell.showItemInFolder(fullPath);
		} catch (error) {
			console.warn("Music Library Player: could not reveal track file", error);
			new Notice(this.tr("revealFailed", { path: track.path }));
		}
	}

	async playTrack(id: string, isFallback = false): Promise<void> {
		const track = this.getTrack(id);
		if (!track) return;
		const requestId = ++this.playbackRequestId;
		if (track.kind === "youtube" && !this.getQueue().some((queued) => queued.id === track.id)) {
			this.settings.queueSelection = "all";
			this.view?.render();
		}
		if (track.kind === "youtube" && !this.settings.youtubeEnabled) {
			new Notice(this.tr("youtubeOff"));
			return;
		}
		if (track.kind === "youtube" && !navigator.onLine) {
			new Notice(this.tr("youtubeOffline"));
			await this.handleYoutubeFailure();
			return;
		}
		if (track.kind === "youtube") {
			if (track.title === `YouTube ${track.videoId}`) track.title = "YouTube";
			void this.resolveYoutubeTitle(track);
		}
		this.currentTrackId = id;
		this.settings.lastTrackId = id;
		this.isPlaying = false;
		this.view?.renderTrackState();
		if (track.kind === "local") {
		this.pendingYoutubeAutoplayId = null;
			this.youtubePlayer?.pauseVideo();
			this.isYoutubePlaying = false;
			if (!this.audio) this.audio = new Audio();
			this.audio.pause();
			this.audioTrackId = null;
			try {
				const sourceUrl = await this.localTrackUrl(track);
				if (requestId !== this.playbackRequestId) {
					URL.revokeObjectURL(sourceUrl);
					return;
				}
				this.revokeAudioObjectUrl();
				this.audio.currentTime = 0;
				this.audio.src = sourceUrl;
				this.audioObjectUrl = sourceUrl;
				this.audioTrackId = track.id;
				this.audio.volume = this.settings.volume;
				await this.audio.play();
				if (requestId !== this.playbackRequestId) return;
				this.settings.lastLocalTrackId = track.id;
				this.isPlaying = true;
			} catch (error) {
				console.error("Music Library Player: local playback failed", error);
				if (requestId === this.playbackRequestId) new Notice(this.tr("trackUnavailable", { path: track.path }));
				this.isPlaying = false;
			}
			this.syncView();
			await this.saveData(this.settings);
			return;
		}

		this.audio?.pause();
		this.audio?.removeAttribute("src");
		this.audio?.load();
		this.audioTrackId = null;
		this.revokeAudioObjectUrl();
		this.isYoutubePlaying = false;
		if (this.youtubePlayer && this.youtubePlayerReady) {
			this.currentTrackId = track.id;
			this.youtubeLoadedTrackId = track.id;
			this.pendingYoutubeAutoplayId = null;
			this.youtubePreviewClosed = false;
			this.view?.setYoutubeLabel(this.getDisplayTitle(track));
			this.youtubePlayer.loadVideoById(track.videoId);
			this.youtubePlayer.playVideo();
			this.isPlaying = true;
			this.isYoutubePlaying = true;
			this.syncView();
			void this.saveData(this.settings);
			return;
		}
		await this.openPlayer();
		try {
			await this.showYoutubeTrack(track, true, !isFallback);
		} catch (error) {
			console.error("Music Library Player: YouTube player failed", error);
			await this.handleYoutubeFailure();
		}
		this.syncView();
		await this.saveData(this.settings);
	}

	private async localTrackUrl(track: LocalTrack): Promise<string> {
		const filePath = track.path.startsWith("vault:") ? track.path.slice("vault:".length) : track.path;
		if (!path.isAbsolute(filePath)) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) throw new Error(`Vault audio file does not exist: ${filePath}`);
			return this.app.vault.getResourcePath(file);
		}
		const contents = await fs.readFile(filePath);
		const data = contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer;
		return URL.createObjectURL(new Blob([data], { type: getAudioMimeType(filePath) }));
	}

	private revokeAudioObjectUrl(): void {
		if (this.audioObjectUrl?.startsWith("blob:")) URL.revokeObjectURL(this.audioObjectUrl);
		this.audioObjectUrl = null;
	}

	async togglePlayback(): Promise<void> {
		if (this.isPlaying) {
			this.pausePlayback();
			return;
		}
		if (!this.currentTrackId) {
			const queue = this.getQueue();
			const first = this.settings.playbackMode === "random" ? this.getRandomTrack(queue) : queue[0];
			if (first) await this.playTrack(first.id);
			return;
		}
		const track = this.getTrack(this.currentTrackId);
		if (track?.kind === "youtube") {
			if (this.youtubePlayer && this.youtubePlayerReady) {
				this.pendingYoutubeAutoplayId = null;
				this.youtubePreviewClosed = false;
				this.view?.setYoutubeLabel(this.getDisplayTitle(track));
				if (this.youtubeLoadedTrackId !== track.id) {
					this.youtubeLoadedTrackId = track.id;
					this.youtubePlayer.loadVideoById(track.videoId);
				} else this.youtubePlayer.playVideo();
			} else {
				await this.playTrack(track.id);
			}
		} else if (this.audio?.src && !this.audio.ended) {
			try { await this.audio.play(); } catch { await this.playTrack(this.currentTrackId); }
		} else {
			await this.playTrack(this.currentTrackId);
		}
	}

	pausePlayback(): void {
		this.playbackRequestId += 1;
		const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
		if (track?.kind === "youtube") this.youtubePlayer?.pauseVideo();
		else this.audio?.pause();
		this.isPlaying = false;
		this.isYoutubePlaying = false;
		this.syncView();
	}

	stopPlayback(): void {
		this.playbackRequestId += 1;
		this.audio?.pause();
		if (this.audio) {
			this.audio.currentTime = 0;
			this.audio.removeAttribute("src");
			this.audio.load();
		}
		this.audioTrackId = null;
		this.revokeAudioObjectUrl();
		this.youtubePlayer?.stopVideo();
		this.pendingYoutubeAutoplayId = null;
		this.isPlaying = false;
		this.isYoutubePlaying = false;
		this.syncView();
	}

	async nextTrack(): Promise<void> {
		const queue = this.getQueue();
		if (!queue.length) return;
		if (this.settings.playbackMode === "random") {
			await this.playTrack(this.getRandomTrack(queue)?.id ?? queue[0].id);
			return;
		}
		const index = queue.findIndex((track) => track.id === this.currentTrackId);
		const nextIndex = index < 0 ? 0 : index + 1;
		if (nextIndex >= queue.length) {
			if (this.settings.playbackMode === "repeat") await this.playTrack(queue[0].id);
			else this.stopPlayback();
			return;
		}
		await this.playTrack(queue[nextIndex].id);
	}

	async previousTrack(): Promise<void> {
		if (this.settings.playbackMode === "random" && this.randomHistoryIndex > 0) {
			this.randomHistoryIndex -= 1;
			await this.playTrack(this.randomHistory[this.randomHistoryIndex]);
			return;
		}
		const queue = this.getQueue();
		if (!queue.length) return;
		const index = queue.findIndex((track) => track.id === this.currentTrackId);
		const previous = index <= 0 ? (this.settings.playbackMode === "repeat" ? queue.length - 1 : 0) : index - 1;
		await this.playTrack(queue[previous].id);
	}

	private async advanceAfterCurrent(): Promise<void> {
		const queue = this.getQueue();
		if (!queue.length) return;
		if (this.settings.playbackMode === "random") {
			const next = this.getRandomTrack(queue);
			if (next) await this.playTrack(next.id);
			return;
		}
		const index = queue.findIndex((track) => track.id === this.currentTrackId);
		if (index >= 0 && index + 1 < queue.length) {
			await this.playTrack(queue[index + 1].id);
		} else if (this.settings.playbackMode === "repeat") {
			await this.playTrack(queue[0].id);
		} else {
			this.isPlaying = false;
			this.syncView();
		}
	}

	private getRandomTrack(queue: PlayerTrack[]): PlayerTrack | undefined {
		if (queue.length === 1) return queue[0];
		const candidates = queue.filter((track) => track.id !== this.currentTrackId);
		const track = candidates[Math.floor(Math.random() * candidates.length)];
		if (track) {
			this.randomHistory = this.randomHistory.slice(0, this.randomHistoryIndex + 1);
			this.randomHistory.push(track.id);
			this.randomHistoryIndex = this.randomHistory.length - 1;
		}
		return track;
	}

	private findLastLocalInQueue(): LocalTrack | undefined {
		const lastId = this.settings.lastLocalTrackId;
		return this.getQueue().find((track): track is LocalTrack => track.kind === "local" && track.id === lastId);
	}

	closeYoutubePreview(): void {
		this.youtubePreviewRequestId += 1;
		this.youtubePreviewClosed = true;
		this.pendingYoutubeAutoplayId = null;
		this.youtubePlayer?.pauseVideo();
		if (this.currentTrackId && this.getTrack(this.currentTrackId)?.kind === "youtube") {
			this.isPlaying = false;
			this.isYoutubePlaying = false;
			this.syncView();
		}
		this.view?.hideYoutubePreview();
	}

	showCurrentYoutubePreview(): void {
		const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
		if (track?.kind !== "youtube" || !this.settings.youtubeEnabled || !navigator.onLine) return;
		this.youtubePreviewClosed = false;
		if (this.youtubePlayer && this.youtubeLoadedTrackId === track.id) {
			this.view?.setYoutubeLabel(this.getDisplayTitle(track));
			return;
		}
		void this.showYoutubeTrack(track, false, true).catch((error) => {
			console.error("Music Library Player: could not show YouTube preview", error);
			void this.handleYoutubeFailure(true);
		});
	}

	private async showYoutubeTrack(track: YouTubeTrack, autoplay: boolean, recordAsCurrent: boolean): Promise<void> {
		if (!this.settings.youtubeEnabled) throw new Error("YouTube playback is disabled");
		const requestId = ++this.youtubePreviewRequestId;
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MUSIC_PLAYER)[0];
		if (!leaf) await this.openPlayer();
		const view = this.view;
		if (!view) throw new Error("Player view is not ready");
		const host = view.getYoutubeHost();
		this.youtubePreviewClosed = false;
		this.youtubeLoadedTrackId = track.id;
		view.setYoutubeLabel(this.getDisplayTitle(track));
		const api = await this.ensureYoutubeApi();
		if (requestId !== this.youtubePreviewRequestId || this.isUnloading || !this.settings.youtubeEnabled || !navigator.onLine) return;
		if (this.youtubePlayer) {
			if (recordAsCurrent) {
				this.currentTrackId = track.id;
				this.settings.lastTrackId = track.id;
			}
			if (autoplay && this.youtubePlayerReady) {
				this.youtubePlayer.loadVideoById(track.videoId);
				this.youtubePlayer.playVideo();
			} else if (autoplay) {
				this.pendingYoutubeAutoplayId = track.id;
				this.youtubePlayer.cueVideoById(track.videoId);
			} else this.youtubePlayer.cueVideoById(track.videoId);
			return;
		}
		if (autoplay) this.pendingYoutubeAutoplayId = track.id;
		host.id = "music-library-player-youtube-host";
		this.youtubePlayer = new api.Player(host.id, {
			width: "200",
			height: "200",
			videoId: track.videoId,
			playerVars: { controls: 1, playsinline: 1, fs: 1, autoplay: 0 },
			events: {
				onReady: (event: { target: YoutubePlayer }) => {
					this.youtubePlayerReady = true;
					event.target.setVolume(Math.round(this.settings.volume * 100));
					const pendingId = this.pendingYoutubeAutoplayId;
					if (pendingId) {
						const pendingTrack = this.getTrack(pendingId);
						if (pendingTrack?.kind === "youtube") event.target.loadVideoById(pendingTrack.videoId);
						this.pendingYoutubeAutoplayId = null;
						event.target.playVideo();
					}
				},
				onStateChange: (event: { data: number }) => {
					if (!window.YT) return;
					const activeTrackId = this.youtubeLoadedTrackId;
					if (!activeTrackId) return;
					if (event.data === window.YT.PlayerState.PLAYING) {
						if (this.youtubePreviewClosed) {
							this.youtubePlayer?.pauseVideo();
							return;
						}
						if (this.currentTrackId !== activeTrackId) {
							this.playbackRequestId += 1;
							this.audio?.pause();
							this.audio?.removeAttribute("src");
							this.audio?.load();
							this.audioTrackId = null;
							this.revokeAudioObjectUrl();
							this.currentTrackId = activeTrackId;
							this.settings.lastTrackId = activeTrackId;
						}
						this.isYoutubePlaying = true;
						this.isPlaying = true;
						try {
							const track = this.getTrack(activeTrackId);
							const videoData = this.youtubePlayer?.getVideoData?.();
							if (track?.kind === "youtube" && videoData?.video_id === track.videoId && videoData.title) {
								void this.saveResolvedYoutubeTitle(track, videoData.title).catch((error) => console.warn("Music Library Player: could not save YouTube title", error));
							}
						} catch (error) {
							console.warn("Music Library Player: YouTube player title unavailable", error);
						}
						if (this.currentTrackId) this.settings.lastTrackId = this.currentTrackId;
						this.syncView();
						void this.saveData(this.settings);
					} else if (event.data === window.YT.PlayerState.ENDED) {
						if (this.currentTrackId !== activeTrackId) return;
						this.currentTrackId = activeTrackId;
						this.isYoutubePlaying = false;
						void this.advanceAfterCurrent();
					} else if (event.data === window.YT.PlayerState.PAUSED) {
						if (this.currentTrackId !== activeTrackId) return;
						this.isYoutubePlaying = false;
						this.isPlaying = false;
						this.syncView();
					}
				},
					onError: (event: { data: number }) => {
						const activeTrackId = this.youtubeLoadedTrackId;
						const message = this.youtubeErrorMessage(event.data);
						if (activeTrackId && this.currentTrackId === activeTrackId) void this.handleYoutubeFailure(false, message);
						else this.view?.showYoutubeError(message, this.findLastLocalInQueue(), () => {
							const fallback = this.findLastLocalInQueue();
							if (fallback) void this.playTrack(fallback.id, true);
							else void this.openLocalTrackPicker();
						});
					},
					onAutoplayBlocked: () => {
						const activeTrackId = this.youtubeLoadedTrackId;
						if (activeTrackId && this.currentTrackId === activeTrackId) {
							this.isYoutubePlaying = false;
							this.isPlaying = false;
							this.syncView();
							new Notice(this.tr("youtubeAutoplayBlocked"));
						}
					},
			},
		});
		if (recordAsCurrent) {
			this.currentTrackId = track.id;
			this.settings.lastTrackId = track.id;
		}
	}

	private ensureYoutubeApi(): Promise<YoutubeApi> {
		if (window.YT) return Promise.resolve(window.YT);
		if (this.youtubeApiPromise) return this.youtubeApiPromise;
		const pending = new Promise<YoutubeApi>((resolve, reject) => {
			const previous = window.onYouTubeIframeAPIReady;
			let script = document.querySelector<HTMLScriptElement>('script[src*="youtube.com/iframe_api"]');
			const shouldAppend = !script;
			if (!script) script = document.createElement("script");
			const timeout = window.setTimeout(() => {
				script?.remove();
				reject(new Error("YouTube API load timed out"));
			}, 15000);
			window.onYouTubeIframeAPIReady = () => {
				try { previous?.(); } catch (error) { console.warn("Music Library Player: previous YouTube callback failed", error); }
				window.clearTimeout(timeout);
				if (window.YT) resolve(window.YT);
				else {
					script?.remove();
					reject(new Error("YouTube API did not initialize"));
				}
			};
			script.onerror = () => {
				window.clearTimeout(timeout);
				script?.remove();
				reject(new Error("Could not load YouTube API"));
			};
			if (shouldAppend) {
				script.src = "https://www.youtube.com/iframe_api";
				document.head.appendChild(script);
			}
		});
		this.youtubeApiPromise = pending;
		void pending.catch(() => {
			if (this.youtubeApiPromise === pending) this.youtubeApiPromise = null;
		});
		return pending;
	}

	private youtubeErrorMessage(errorCode: number): string {
		if (errorCode === 153) return this.tr("youtubeNoReferer");
		if (errorCode === 101 || errorCode === 150) return this.tr("youtubeCannotEmbed");
		return this.tr("youtubeFailure");
	}

	private async handleYoutubeFailure(fromPreview = false, errorMessage?: string): Promise<void> {
		const message = errorMessage ?? this.tr("youtubeFailure");
		this.isPlaying = false;
		this.isYoutubePlaying = false;
		this.youtubePlayer?.pauseVideo();
		this.syncView();
		const fallback = this.findLastLocalInQueue();
		if (fallback && this.settings.autoSwitchToLastLocal && !fromPreview) {
			new Notice(message);
			await this.playTrack(fallback.id, true);
			return;
		}
		if (!navigator.onLine) {
			this.view?.hideYoutubePreview();
			this.view?.render();
			new Notice(this.tr("youtubeOffline"));
			return;
		}
		this.view?.showYoutubeError(message, fallback, () => {
			if (fallback) void this.playTrack(fallback.id, true);
			else this.openLocalTrackPicker();
		});
		if (!this.view) new Notice(message);
	}

	private async openLocalTrackPicker(): Promise<void> {
		const tracks = this.settings.tracks;
		if (tracks.length) {
			new VaultAudioSuggestModal(this.app, tracks, (track) => void this.playTrack(track.id)).open();
			return;
		}
		const files = await this.openFileDialog();
		if (files.length) {
			await this.addExternalFiles(files);
			const last = this.settings.tracks[this.settings.tracks.length - 1];
			if (last) await this.playTrack(last.id, true);
		}
	}

	private syncView(): void {
		this.view?.renderTrackState();
		this.refreshStatusBar();
	}

	refreshStatusBar(): void {
		const button = this.statusBarButton;
		if (!button) return;
		const item = button.parentElement;
		if (item) {
			item.dataset.palette = this.settings.palette;
			item.dataset.appearance = this.settings.appearance;
		}
		const label = this.tr(this.isPlaying ? "pause" : "play");
		const track = this.currentTrackId ? this.getTrack(this.currentTrackId) : null;
		button.empty();
		setIcon(button, this.isPlaying ? "pause" : "play");
		button.setAttribute("aria-label", label);
		button.setAttribute("title", track ? `${label} · ${this.getDisplayTitle(track)}` : label);
		button.setAttribute("aria-pressed", String(this.isPlaying));
	}

	private onHotkeyPressed(event: KeyboardEvent): void {
		if (event.repeat || (document.activeElement instanceof HTMLElement && document.activeElement.hasClass("mlp-hotkey-input"))) return;
		const shortcut = shortcutFromEvent(event);
		if (!shortcut) return;
		const action = this.settings.hotkeys.playPause === shortcut ? "playPause"
			: this.settings.hotkeys.nextTrack === shortcut ? "nextTrack"
				: this.settings.hotkeys.previousTrack === shortcut ? "previousTrack"
					: this.settings.hotkeys.openPlayer === shortcut ? "openPlayer" : null;
		if (!action) return;
		event.preventDefault();
		event.stopPropagation();
		if (action === "playPause") void this.togglePlayback();
		else if (action === "nextTrack") void this.nextTrack();
		else if (action === "previousTrack") void this.previousTrack();
		else void this.openPlayer();
	}

	onViewClosed(view: MusicPlayerView): void {
		if (this.view === view) this.view = null;
		this.youtubePreviewRequestId += 1;
		if (this.isYoutubePlaying) {
			this.youtubePlayer?.pauseVideo();
			this.isYoutubePlaying = false;
			this.isPlaying = false;
			new Notice(this.tr("stopYoutubeWhenHidden"));
		}
		this.youtubePlayer?.destroy();
		this.youtubePlayer = null;
		this.youtubeLoadedTrackId = null;
		this.youtubePlayerReady = false;
		this.pendingYoutubeAutoplayId = null;
	}

	async openTrackInfo(track: PlayerTrack, index: number): Promise<void> {
		new TrackInfoModal(this.app, this.tr("trackNumber"), index + 1, this.getDisplayTitle(track)).open();
	}

	async openGuide(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.settings.guidePath ?? GUIDE_PATH);
		if (!(file instanceof TFile)) {
			new Notice(this.tr("guideTitle"));
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	async addTrackToAnyPlaylist(track: PlayerTrack, alwaysChoose = false): Promise<void> {
		if (!alwaysChoose && this.settings.queueSelection.startsWith("playlist:")) {
			const selected = this.settings.playlists.find((playlist) => playlist.id === this.settings.queueSelection.slice(9));
			if (selected) {
				if (selected.trackIds.includes(track.id)) await this.removeTrackFromPlaylist(track.id, selected);
				else await this.addTrackToPlaylist(track.id, selected);
				return;
			}
		}
		if (!this.settings.playlists.length) {
			await this.addPlaylist(this.tr("playlists"));
		}
		const available = this.settings.playlists.filter((playlist) => !playlist.trackIds.includes(track.id));
		if (!available.length) {
			new Notice(this.tr("createAnotherPlaylist"));
			return;
		}
		new PlaylistSuggestModal(this.app, available, (playlist) => void this.addTrackToPlaylist(track.id, playlist)).open();
	}

	async addPlaylistToAnyCollection(): Promise<void> {
		const selected = this.settings.queueSelection.startsWith("collection:")
			? this.settings.collections.find((item) => item.id === this.settings.queueSelection.slice(11))
			: undefined;
		if (!selected) return;
		new PlaylistSuggestModal(this.app, this.settings.playlists, (playlist) => void this.addPlaylistToCollection(selected, playlist)).open();
	}

	async removeFromCollection(collection: PlaybackCollection, playlistId: string): Promise<void> {
		collection.playlists = collection.playlists.filter((entry) => entry.playlistId !== playlistId);
		await this.persistAndRender();
	}

	async addRule(event: ActionEvent): Promise<void> {
		if (event !== "manual-pattern" && this.settings.taskSoundRules.some((rule) => rule.event === event)) return;
		this.settings.taskSoundRules.push({ id: this.newId("rule"), event, path: "", preset: event === "app-started" ? "startupAurora" : "soft", enabled: true, pattern: "" });
		await this.persistAndRender();
	}

	async updateRule(rule: TaskSoundRule, update: Partial<TaskSoundRule>): Promise<void> {
		Object.assign(rule, update);
		await this.persistAndRender();
	}

	async removeRule(ruleId: string): Promise<void> {
		this.settings.taskSoundRules = this.settings.taskSoundRules.filter((rule) => rule.id !== ruleId);
		await this.persistAndRender();
	}

	async chooseTaskSound(rule: TaskSoundRule): Promise<void> {
		const files = await this.openFileDialog();
		if (files[0]) await this.updateRule(rule, { path: files[0], preset: null });
	}

	private async registerVaultEvents(): Promise<void> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			try { this.markdownSnapshots.set(file.path, await this.app.vault.cachedRead(file)); } catch { /* skip unreadable notes */ }
		}
		this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
			if (file.path.startsWith("Инструкция — Музыкальный плеер")) return;
			void this.app.vault.cachedRead(file).then((data) => this.markdownSnapshots.set(file.path, data));
			this.playActionSound("note-created");
		}));
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
			void this.onMarkdownModified(file);
		}));
		this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
			this.markdownSnapshots.delete(oldPath);
			void this.app.vault.cachedRead(file).then((data) => this.markdownSnapshots.set(file.path, data));
			this.playActionSound("note-renamed");
		}));
	}

	private onTaskCheckboxChanged(event: Event): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || !target.matches(".task-list-item-checkbox") || !target.checked) return;
		const hasTaskSound = this.settings.taskSoundRules.some((rule) => rule.event === "task-completed" && rule.enabled && (rule.path || rule.preset));
		if (!hasTaskSound) return;
		this.pendingTaskCompletionClicks.push(Date.now());
		this.playActionSound("task-completed");
	}

	private async onMarkdownModified(file: TFile): Promise<void> {
		const previousWork = this.markdownUpdateQueue.get(file.path) ?? Promise.resolve();
		const currentWork = previousWork.catch(() => undefined).then(async () => {
			try {
				const next = await this.app.vault.cachedRead(file);
				const previous = this.markdownSnapshots.get(file.path);
				const completedDelta = previous === undefined ? 0 : countNewCompletedTasks(previous, next);
				if (completedDelta) {
					const cutoff = Date.now() - 10000;
					this.pendingTaskCompletionClicks = this.pendingTaskCompletionClicks.filter((createdAt) => createdAt >= cutoff);
					for (let i = 0; i < completedDelta; i += 1) {
						if (this.pendingTaskCompletionClicks.length) this.pendingTaskCompletionClicks.shift();
						else this.playActionSound("task-completed");
					}
				} else this.playActionSound("note-modified");
				if (previous !== undefined) this.playManualPatternRules(previous, next);
				this.markdownSnapshots.set(file.path, next);
			} catch { /* ignore transient vault errors */ }
		});
		this.markdownUpdateQueue.set(file.path, currentWork);
		try { await currentWork; } finally {
			if (this.markdownUpdateQueue.get(file.path) === currentWork) this.markdownUpdateQueue.delete(file.path);
		}
	}

	private playActionSound(event: ActionEvent): void {
		const rule = this.settings.taskSoundRules.find((item) => item.event === event && item.enabled && (item.path || item.preset));
		if (rule) this.playRuleSound(rule);
	}

	private playManualPatternRules(previous: string, next: string): void {
		for (const rule of this.settings.taskSoundRules) {
			if (rule.event !== "manual-pattern" || !rule.enabled || (!rule.path && !rule.preset) || !rule.pattern?.trim()) continue;
			if (matchesNewPattern(rule.pattern, previous, next)) this.playRuleSound(rule);
		}
	}

	private playRuleSound(rule: TaskSoundRule): void {
		if (this.isUnloading) return;
		const requestId = ++this.taskSoundRequestId;
		this.stopTaskCue();
		if (rule.preset) {
			void this.playBuiltInCue(rule.preset, requestId);
			return;
		}
		if (!rule.path) return;
		void this.playCustomTaskSound(rule.path, requestId);
	}

	private async playCustomTaskSound(path: string, requestId: number): Promise<void> {
		try {
			const bytes = await fs.readFile(path);
			if (this.isUnloading || requestId !== this.taskSoundRequestId) return;
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			const url = URL.createObjectURL(new Blob([buffer], { type: getAudioMimeType(path) }));
			this.taskSoundObjectUrl = url;
			this.taskAudio = new Audio(url);
			this.taskAudio.volume = 1;
			await this.taskAudio.play();
		} catch (error) {
			if (requestId === this.taskSoundRequestId) console.error("Music Library Player: task sound failed", error);
		}
	}

	private async playBuiltInCue(preset: NonNullable<TaskSoundRule["preset"]>, requestId: number): Promise<void> {
		const context = this.taskSoundContext ??= new AudioContext();
		if (context.state === "suspended") {
			try { await context.resume(); } catch { return; }
		}
		if (this.isUnloading || requestId !== this.taskSoundRequestId) return;
		if (preset === "cashDrawer" || preset === "fallingCoin" || preset === "screenKnock" || preset === "icqMessage" || preset === "monkeySqueal") {
			this.playEffectCue(context, preset);
			return;
		}
		const now = context.currentTime;
		const schedules: Partial<Record<NonNullable<TaskSoundRule["preset"]>, Array<[number, number, OscillatorType, number]>>> = {
			chime: [[880, 0, "sine", 0.28], [1320, 0.04, "sine", 0.34]],
			soft: [[660, 0, "sine", 0.22]],
			pop: [[520, 0, "triangle", 0.09]],
			double: [[620, 0, "sine", 0.11], [820, 0.16, "sine", 0.13]],
			click: [[1250, 0, "square", 0.025]],
			sonar: [[440, 0, "sine", 0.32], [660, 0.12, "sine", 0.3]],
			marimba: [[523, 0, "triangle", 0.13], [659, 0.12, "triangle", 0.15], [784, 0.26, "triangle", 0.19]],
			harp: [[784, 0, "sine", 0.3], [988, 0.055, "sine", 0.27], [1175, 0.11, "sine", 0.25]],
			notification: [[698, 0, "sine", 0.12], [932, 0.14, "sine", 0.2]],
			woodblock: [[420, 0, "triangle", 0.07], [620, 0.09, "triangle", 0.08]],
			complete: [[784, 0, "sine", 0.12], [988, 0.13, "sine", 0.12], [1175, 0.26, "sine", 0.32]],
			startupAurora: [[392, 0, "sine", 0.26], [523, 0.14, "sine", 0.28], [659, 0.29, "sine", 0.3], [784, 0.48, "sine", 0.36]],
			startupGlass: [[659, 0, "sine", 0.22], [988, 0.16, "sine", 0.24], [1319, 0.34, "sine", 0.29]],
			startupWelcome: [[330, 0, "triangle", 0.21], [440, 0.17, "triangle", 0.23], [554, 0.35, "triangle", 0.25], [659, 0.55, "sine", 0.3]],
			startupRipple: [[523, 0, "sine", 0.3], [698, 0.08, "sine", 0.29], [880, 0.18, "sine", 0.3], [1047, 0.29, "sine", 0.34]],
			startupOrbit: [[440, 0, "sine", 0.2], [587, 0.13, "sine", 0.23], [740, 0.31, "sine", 0.27], [880, 0.52, "sine", 0.33]],
		};
		const notes = schedules[preset];
		if (!notes) return;
		const gain = context.createGain();
		gain.connect(context.destination);
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
		gain.gain.setValueAtTime(0.18, now + 0.04);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(...notes.map((item) => item[1] + item[3])));
		this.taskSoundGain = gain;
		this.taskSoundNodes = notes.map(([frequency, offset, type, duration]) => {
			const oscillator = context.createOscillator();
			oscillator.type = type;
			oscillator.frequency.setValueAtTime(frequency, now + offset);
			oscillator.connect(gain);
			oscillator.start(now + offset);
			oscillator.stop(now + offset + duration);
			return oscillator;
		});
	}

	private playEffectCue(context: AudioContext, preset: "cashDrawer" | "fallingCoin" | "screenKnock" | "icqMessage" | "monkeySqueal"): void {
		let buffer = this.effectBuffers.get(preset);
		if (!buffer) {
			const sampleRate = context.sampleRate;
			const duration = preset === "monkeySqueal" ? 0.95 : preset === "fallingCoin" ? 0.68 : preset === "icqMessage" ? 0.62 : 0.5;
			buffer = context.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
			const samples = buffer.getChannelData(0);
			let seed = 0x12345678;
			const tone = (time: number, start: number, decay: number, frequency: number, noise: number, random: number): number => {
				if (time < start) return 0;
				const age = time - start;
				return Math.exp(-age * decay) * (Math.sin(2 * Math.PI * frequency * age) + noise * random);
			};
			const coinBounces = [[0, 0.8, 1700], [0.15, 0.55, 1900], [0.3, 0.35, 2150], [0.44, 0.2, 2350]];
			const screenKnocks = [[0, 0.7], [0.15, 0.85], [0.32, 1]];
			const messageNotes = [[0, 0.22, 390], [0.29, 0.25, 310]];
			for (let index = 0; index < samples.length; index++) {
				const time = index / sampleRate;
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				const random = seed / 2147483648 - 1;
				let value = 0;
				if (preset === "cashDrawer") {
					value = (time < 0.17 ? random * 0.1 * (0.3 + time * 3) : 0)
						+ tone(time, 0.17, 30, 125, 0.5, random) * 0.7
						+ tone(time, 0.31, 55, 880, 0.15, random) * 0.3;
				} else if (preset === "fallingCoin") {
					for (const [start, volume, frequency] of coinBounces) {
						value += volume * tone(time, start, 19, frequency, 0.15, random);
						value += volume * 0.4 * tone(time, start, 24, frequency * 1.47, 0, random);
					}
				} else if (preset === "screenKnock") {
					for (const [start, volume] of screenKnocks) {
						value += volume * tone(time, start, 65, 190, 0.6, random);
					}
				} else if (preset === "icqMessage") {
					for (const [start, length, frequency] of messageNotes) {
						const age = time - start;
						if (age < 0 || age > length) continue;
						const envelope = Math.sin(Math.PI * age / length) ** 2;
						const phase = 2 * Math.PI * frequency * (age + 0.12 * age * age);
						value += envelope * (Math.sin(phase) + 0.42 * Math.sin(phase * 2) + 0.2 * Math.sin(phase * 3));
					}
				} else {
					for (const [start, length, base] of [[0, 0.36, 430], [0.34, 0.5, 510]]) {
						const age = time - start;
						if (age < 0 || age >= length) continue;
						const progress = age / length;
						const envelope = Math.sin(Math.PI * progress) ** 0.7;
						const frequency = base + 380 * Math.sin(Math.PI * progress) + 90 * Math.sin(2 * Math.PI * 13 * age);
						const phase = 2 * Math.PI * frequency * age;
						value += envelope * (0.58 * Math.sin(phase) + 0.21 * Math.sin(phase * 2) + 0.12 * random);
					}
				}
				samples[index] = Math.max(-1, Math.min(1, value * 0.5));
			}
			this.effectBuffers.set(preset, buffer);
		}
		const source = context.createBufferSource();
		const gain = context.createGain();
		gain.gain.value = 0.45;
		source.buffer = buffer;
		source.connect(gain);
		gain.connect(context.destination);
		this.taskSoundNodes = [source];
		this.taskSoundGain = gain;
		source.start();
	}

	private stopTaskCue(): void {
		this.taskAudio?.pause();
		this.taskAudio?.removeAttribute("src");
		this.taskAudio?.load();
		this.taskAudio = null;
		if (this.taskSoundObjectUrl) URL.revokeObjectURL(this.taskSoundObjectUrl);
		this.taskSoundObjectUrl = null;
		for (const node of this.taskSoundNodes) {
			try { node.stop(); } catch { /* already ended */ }
			node.disconnect();
		}
		this.taskSoundNodes = [];
		this.taskSoundGain?.disconnect();
		this.taskSoundGain = null;
	}

	private async createAndShowGuideOnce(): Promise<void> {
		if (this.settings.guideShown) return;
		try {
			let targetPath = this.settings.guidePath ?? GUIDE_PATH;
			let abstract = this.app.vault.getAbstractFileByPath(targetPath);
			if (abstract && !this.settings.guidePath) {
				let suffix = 2;
				do {
					targetPath = `Инструкция — Музыкальный плеер (${suffix++}).md`;
					abstract = this.app.vault.getAbstractFileByPath(targetPath);
				} while (abstract);
			}
			if (!abstract) abstract = await this.app.vault.create(targetPath, this.getGuideMarkdown());
			if (!(abstract instanceof TFile)) return;
			this.settings.guidePath = targetPath;
			await this.saveData(this.settings);
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.openFile(abstract);
			this.settings.guideShown = true;
			await this.saveData(this.settings);
		} catch (error) {
			console.error("Music Library Player: could not create the user guide", error);
		}
	}

	private getGuideMarkdown(): string {
		return `# Music Player — руководство / інструкція / user guide\n\n` +
			`> ${this.tr("guideIntro")}\n\n` +
			`## Українська\n\n` +
			`### Музична бібліотека\nУ налаштуваннях плеєра додайте окремий аудіофайл або папку з vault чи зовнішнього диска, а потім натисніть «Індексувати». Формати залежать від можливостей вбудованого браузера Obsidian. Індексація створює список шляхів; оригінали не копіюються, не переміщуються та не змінюються. Видалення треку з індексу не видаляє файл. Після змін у папці повторно запустіть індексацію.\n\n` +
			`### Керування відтворенням\nКнопки керують попереднім треком, відтворенням/паузою, зупинкою та наступним треком. Режим «Послідовно» зупиняється після кінця черги; «Повтор» запускає чергу знову; «Випадково» вибирає наступний трек навмання. Натисніть кнопку гучності, щоб відкрити горизонтальний повзунок; клацання поза ним закриває віконце. Під кнопками є анімовані стовпчики, повзунок перемотування, прослуханий час, час до кінця та повна тривалість. Перетягніть повзунок, щоб перейти до іншого місця треку. Нерухома назва скорочується до 40 символів, а при ввімкненому прокручуванні повна назва рухається безперервно. Натисніть назву в рядку плеєра, щоб перейменувати трек; файл на диску не змінюється. Натисніть назву папки біля треку, щоб показати файл у теці.\n\n` +
			`### Плейлисти й колекції\nСтворіть плейлист і додайте треки кнопкою «+» біля кожного треку. Коли вибрано плейлист, відображаються лише його треки. Кнопкою «+» можна вибрати один трек, а кнопками папок — додати всі треки із зовнішньої папки або vault. Колекція об'єднує кілька плейлистів; зніміть прапорець, щоб тимчасово вимкнути плейлист, не видаляючи його з колекції. Виберіть плейлист або колекцію у списку черги поруч із кнопками.\n\n` +
			`### YouTube\nYouTube вимкнений за замовчуванням, і плеєр працює лише з локальними файлами. Щоб додати посилання, спершу ввімкніть YouTube у налаштуваннях, потім вставте повну URL-адресу відео й натисніть Enter або значок посилання. Кожне нове посилання потрапляє до вбудованого плейлиста YouTube; його можна додати й до іншого плейлиста. Коли інтернету немає, онлайн-список і плеєр приховані. Натисніть назву треку, кнопку відтворення або значок ока, щоб показати вбудований програвач. Наведення курсора не відкриває відео. Відео лишається видимим, поки ви не натиснете кнопку приховування; вона також призупиняє YouTube. Кнопка біля назви поточного треку знову показує відео. Залишайте панель відкритою під час відтворення. Якщо YouTube заблокував відео або сталася помилка, скористайтеся кнопкою переходу до локального треку. Автоматичне перемикання на останній локальний трек у поточній черзі вмикається окремо в налаштуваннях.\n\n` +
			`### Налаштування та звуки дій\nОберіть мову інтерфейсу, світлу або темну тему плеєра, палітру кнопок, прокручування повної назви та автозапуск останнього треку (вимкнений за замовчуванням). У розділі звуків дій додайте правило для створення нотатки, зміни/перейменування нотатки або завершення завдання й оберіть один із 21 вбудованого звуку або аудіофайл підтримуваного формату. Нове спрацювання зупиняє попередній звук. Цей посібник можна знову відкрити з налаштувань плагіна.\n\n` +
			`Для ручного правила введіть регулярний вираз: звук лунає, коли відповідний текст уперше з’являється в нотатці.\n\n` +
			`### Швидке керування та звук запуску\nКнопка відтворення/паузи є у рядку стану Obsidian. У налаштуваннях плеєра задайте клавіші для відтворення/паузи, наступного й попереднього треку та відкриття панелі. У розділі звуків дій додайте подію «Запуск Obsidian» та оберіть одну з п’яти коротких оригінальних мелодій. Також доступний звук «Вереск мавпочки». Звуки дій спочатку вимкнені, доки ви не додасте правило. Якщо Obsidian блокує автоматичне відтворення, мелодія запуску пролунає після першої дії користувача.\n\n` +
			`## Русский\n\n` +
			`### Музыкальная библиотека\nВ настройках плеера добавьте отдельный аудиофайл или папку из vault либо с внешнего диска, затем нажмите «Индексировать». Форматы зависят от возможностей встроенного браузера Obsidian. Индексация создаёт список путей: оригиналы не копируются, не перемещаются и не изменяются. Удаление трека из индекса не удаляет файл. После изменений в папке запустите индексацию повторно.\n\n` +
			`### Управление воспроизведением\nКнопки включают предыдущий трек, воспроизведение/паузу, остановку и следующий трек. Режим «По порядку» останавливается в конце очереди; «Повтор» запускает очередь заново; «Случайно» выбирает следующий трек наугад. Нажмите кнопку звука, чтобы открыть горизонтальный ползунок; клик вне него закрывает окно. Под кнопками находятся анимированные столбики, ползунок перемотки, прослушанное время, оставшееся время и полная длительность. Перетащите ползунок, чтобы перейти к другой части трека. Неподвижное название ограничено 40 символами, а при включённой прокрутке полный текст движется непрерывно. Нажмите на название в строке плеера, чтобы переименовать трек; файл на диске не меняется. Нажмите на название папки рядом с треком, чтобы показать файл в проводнике.\n\n` +
			`### Плейлисты и коллекции\nСоздайте плейлист и добавляйте треки кнопкой «+» рядом с каждым треком. При выборе плейлиста показываются только его треки. Кнопкой «+» можно выбрать один трек, а кнопками папок — добавить все треки из внешней папки или vault. Коллекция объединяет несколько плейлистов; снимите флажок, чтобы временно отключить плейлист, не удаляя его из коллекции. Выберите плейлист или коллекцию в списке очереди рядом с кнопками.\n\n` +
			`### YouTube\nYouTube выключен по умолчанию, поэтому плеер работает только с локальными файлами. Чтобы добавить ссылку, сначала включите YouTube в настройках, затем вставьте полный адрес видео и нажмите Enter или значок ссылки. Каждая новая ссылка попадает в предустановленный плейлист YouTube; ее можно добавить и в другой плейлист. Без интернета онлайн-список и плеер скрыты. Нажмите на название трека, кнопку воспроизведения или значок глаза, чтобы показать встроенный проигрыватель. Наведение мыши видео не открывает. Видео остаётся на месте, пока вы не нажмёте кнопку скрытия; эта кнопка также ставит YouTube на паузу. Значок рядом с названием текущего трека снова показывает видео. Оставляйте панель открытой во время воспроизведения. Если YouTube блокирует видео или возникает ошибка, воспользуйтесь кнопкой перехода к локальному треку. Автоматическое переключение на последний локальный трек в текущей очереди включается отдельно в настройках.\n\n` +
			`### Настройки и звуки действий\nВыберите язык интерфейса, светлую или тёмную тему, палитру кнопок, прокрутку полного названия и автозапуск последнего трека (по умолчанию выключен). В разделе звуков действий добавьте правило для создания, изменения или переименования заметки либо завершения задачи и выберите один из 21 встроенного сигнала или аудиофайл в формате, поддерживаемом встроенным аудиодвижком. При новом событии предыдущий звук прерывается. Инструкцию можно повторно открыть в настройках плагина.\n\n` +
			`Для ручного правила введите регулярное выражение: звук запускается, когда подходящий текст впервые появляется в заметке.\n\n` +
			`### Быстрое управление и звук запуска\nКнопка воспроизведения/паузы есть в строке состояния Obsidian. В настройках плеера назначьте сочетания клавиш для воспроизведения/паузы, следующего и предыдущего трека, а также открытия панели. В разделе звуков действий добавьте событие «Запуск Obsidian» и выберите одну из пяти коротких оригинальных мелодий. Также доступен звук «Визг мартышки». Звуки действий по умолчанию выключены, пока вы не добавите правило. Если Obsidian блокирует автоматическое воспроизведение, мелодия запуска прозвучит после первого действия пользователя.\n\n` +
			`## English\n\n` +
			`### Music library\nIn player settings, add an audio file or folder from the vault or an external drive, then select “Index”. Playback supports formats reported by the embedded browser, including MP3, MPEG, WAV, Ogg, Opus, FLAC, AAC, CAF, M4A/M4B, MP4 audio, WebM audio, and E-AC-3 where available. Indexing stores file paths only: originals are not copied, moved, or changed. Removing a track from the index never deletes the file. Re-index after changing the contents of a folder.\n\n` +
			`### Playback controls\nThe buttons play the previous track, play/pause, stop, and play the next track. “In order” stops at the end of the queue; “Repeat” starts the queue again; “Random” picks the next track at random. Click the volume icon to show the horizontal slider; click outside it to close the popup. Below the buttons, animated bars and a seek slider show elapsed time, remaining time, and total duration. Drag the slider to seek. A still title is limited to 40 characters; with scrolling enabled, the full title moves in a continuous loop. Click the title bar to rename a track; the file on disk is unchanged. Click a folder name beside a track to show the file in your file manager.\n\n` +
			`### Playlists and collections\nCreate a playlist and add tracks with the “+” button beside a track. Selecting a playlist shows only its tracks. Use “+” to choose one track, or the folder buttons to add every track from an external or vault folder. A collection combines playlists; clear a checkbox to temporarily disable a playlist without removing it from the collection. Choose a playlist or collection in the queue selector beside the controls.\n\n` +
			`### YouTube\nYouTube is off by default, so the player uses local files only. To add a link, first enable YouTube in settings, then paste the full video URL and press Enter or the link icon. Every new link goes into the built-in YouTube playlist and can also be added to another playlist. When offline, the online list and player are hidden. Click a track title, Play, or the eye icon to show the embedded player. Moving the pointer does not open the video. The video stays visible until you choose to hide it; hiding also pauses YouTube. The icon beside the current track title shows the video again. Keep the player pane open during playback. If YouTube blocks a video or playback fails, use the button to switch to a local track. Automatic switching to the last local track in the current queue is a separate setting.\n\n` +
			`### Settings and action sounds\nChoose the interface language, light or dark player theme, button palette, full-title scrolling, and automatic playback of the last track at startup (off by default). In Action Sounds, add a rule for note creation, note modification/rename, or task completion and choose one of 21 built-in tones or an audio file supported by this desktop build. Each new event interrupts the previous cue. Reopen this guide from plugin settings.\n\n` +
			`For a manual rule, enter a regular expression. Its sound plays when matching text first appears in a note.\n\n` +
			`### Quick controls and startup sound\nThe Obsidian status bar has a play/pause button. Set shortcuts for play/pause, next and previous track, and opening the player pane in the player settings. Under Action sounds, add “Obsidian startup” and choose one of five short original melodies. A playful monkey squeal is also available. Action sounds remain off until you add a rule. If Obsidian blocks automatic audio, the startup melody plays after your first interaction.\n\n` +
			`---\n\nОригиналы не удаляются. / Оригінали не видаляються. / Original files are never deleted.\n`;
	}

	private newId(prefix: string): string {
		return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
	}
}
