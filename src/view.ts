import {
	FuzzySuggestModal,
	ItemView,
	Modal,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import type MusicPlayerPlugin from "./main";
import type { LocalTrack, PlaybackMode, PlayerTrack, Playlist, YouTubeTrack } from "./types";
import { VIEW_TYPE_MUSIC_PLAYER } from "./constants";
import { AUDIO_EXTENSIONS, getFullTrackTitle } from "./core.mjs";
import { marqueeDuration, shouldRestartMarquee } from "./marquee.mjs";

export class MusicPlayerView extends ItemView {
	private root!: HTMLElement;
	private queueSelect!: HTMLSelectElement;
	private modeButton!: HTMLButtonElement;
	private titleButton!: HTMLButtonElement;
	private renderedTitleKey = "";
	private titleAnimation: Animation | null = null;
	private titleAnimationDistance = 0;
	private youtubeToggleButton!: HTMLButtonElement;
	private playButton!: HTMLButtonElement;
	private volumeWrap!: HTMLElement;
	private volumeButton!: HTMLButtonElement;
	private volumePopover!: HTMLElement;
	private volumeRange!: HTMLInputElement;
	private trackStatus!: HTMLElement;
	private seekRange!: HTMLInputElement;
	private elapsedTime!: HTMLElement;
	private remainingTime!: HTMLElement;
	private totalTime!: HTMLElement;
	private progressTimer: number | null = null;
	private isSeeking = false;
	private progressTrackId: string | null = null;
	private trackList!: HTMLElement;
	private libraryList!: HTMLElement;
	private libraryListButton!: HTMLButtonElement;
	private libraryListOpen = false;
	private localTracksTitle!: HTMLElement;
	private collectionPanel!: HTMLElement;
	private collapsedSections = new Set<string>(["youtube-links"]);
	private youtubeSection!: HTMLElement;
	private youtubeHost!: HTMLElement;
	private youtubeLabel!: HTMLElement;
	private youtubeError!: HTMLElement;
	private onlineList!: HTMLElement;
	private urlInput!: HTMLInputElement;
	private linkForm!: HTMLElement;
	private localStatus!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: MusicPlayerPlugin) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_MUSIC_PLAYER; }
	getDisplayText(): string { return this.plugin.tr("pluginName"); }
	getIcon(): string { return "audio-lines"; }

	async onOpen(): Promise<void> {
		this.plugin.view = this;
		this.buildShell();
		this.render();
		this.contentEl.ownerDocument.addEventListener("pointerdown", this.onDocumentPointerDown, true);
		this.contentEl.ownerDocument.addEventListener("keydown", this.onDocumentKeyDown, true);
		this.contentEl.ownerDocument.defaultView?.addEventListener("blur", this.onWindowBlur);
		this.progressTimer = window.setInterval(() => {
			this.renderProgress();
			this.ensureTitleAnimation();
		}, 250);
	}

	async onClose(): Promise<void> {
		this.contentEl.ownerDocument.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
		this.contentEl.ownerDocument.removeEventListener("keydown", this.onDocumentKeyDown, true);
		this.contentEl.ownerDocument.defaultView?.removeEventListener("blur", this.onWindowBlur);
		if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
		this.progressTimer = null;
		this.titleAnimation?.cancel();
		this.titleAnimation = null;
		this.plugin.onViewClosed(this);
	}

	private readonly onDocumentPointerDown = (event: PointerEvent): void => {
		const target = event.target as Node | null;
		const inside = !!target && (this.volumePopover.contains(target) || this.volumeButton.contains(target));
		if (this.volumePopover && !this.volumePopover.hasClass("is-hidden") && !inside) {
			this.setVolumePopoverVisible(false);
		}
	};

	private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") this.setVolumePopoverVisible(false);
	};

	private readonly onWindowBlur = (): void => this.setVolumePopoverVisible(false);

	private setVolumePopoverVisible(visible: boolean): void {
		if (!this.volumePopover) return;
		this.volumePopover.toggleClass("is-hidden", !visible);
		this.volumeButton.setAttribute("aria-expanded", String(visible));
	}

	private buildShell(): void {
		this.contentEl.empty();
		this.contentEl.addClass("mlp-view-content");
		this.root = this.contentEl.createDiv({ cls: "mlp-root" });

		const heading = this.root.createDiv({ cls: "mlp-heading" });
		const title = heading.createEl("h3", { text: this.plugin.tr("pluginName") });
		title.dataset.i18n = "pluginName";
		this.localStatus = heading.createSpan({ cls: "mlp-network-status" });

		const queueRow = this.root.createDiv({ cls: "mlp-queue-row" });
		const queueLabel = queueRow.createSpan({ text: this.plugin.tr("queue") });
		queueLabel.dataset.i18n = "queue";
		this.queueSelect = queueRow.createEl("select", { cls: "mlp-select" });
		this.queueSelect.addEventListener("change", () => void this.plugin.setQueueSelection(this.queueSelect.value));
		this.modeButton = queueRow.createEl("button", { cls: "mlp-icon-button mlp-mode-button" });
		this.modeButton.addEventListener("click", () => {
			const modes: PlaybackMode[] = ["sequential", "repeat", "random"];
			const next = (modes.indexOf(this.plugin.settings.playbackMode) + 1) % modes.length;
			void this.plugin.setPlaybackMode(modes[next]);
		});

		const controls = this.root.createDiv({ cls: "mlp-controls" });
		this.addIconButton(controls, "skip-back", "previous", () => void this.plugin.previousTrack());
		this.playButton = this.addIconButton(controls, "play", "play", () => void this.plugin.togglePlayback());
		this.addIconButton(controls, "square", "stop", () => this.plugin.stopPlayback());
		this.addIconButton(controls, "skip-forward", "next", () => void this.plugin.nextTrack());
		this.libraryListButton = this.addIconButton(controls, "list-music", "showTracks", () => {
			this.libraryListOpen = !this.libraryListOpen;
			this.syncLibraryVisibility();
		});
		this.volumeWrap = controls.createDiv({ cls: "mlp-volume-wrap" });
		this.volumeButton = this.addIconButton(this.volumeWrap, "volume-2", "volume", () => this.setVolumePopoverVisible(this.volumePopover.hasClass("is-hidden")));
		this.volumeButton.setAttribute("aria-expanded", "false");
		this.volumePopover = this.volumeWrap.createDiv({ cls: "mlp-volume-popover is-hidden" });
		const volumeLabel = this.volumePopover.createSpan({ text: this.plugin.tr("volume") });
		volumeLabel.dataset.i18n = "volume";
		this.volumeRange = this.volumePopover.createEl("input", { attr: { type: "range", min: "0", max: "100", step: "1" } });
		this.volumeRange.addEventListener("input", () => void this.plugin.setVolume(Number(this.volumeRange.value) / 100));

		this.trackStatus = this.root.createDiv({ cls: "mlp-track-status" });
		const progressRow = this.trackStatus.createDiv({ cls: "mlp-progress-row" });
		const equalizer = progressRow.createDiv({ cls: "mlp-equalizer", attr: { "aria-hidden": "true" } });
		for (let index = 0; index < 6; index++) equalizer.createSpan({ cls: "mlp-equalizer-bar" });
		this.seekRange = progressRow.createEl("input", { cls: "mlp-seek-range", attr: { type: "range", min: "0", max: "1", step: "0.1", value: "0" } });
		this.seekRange.disabled = true;
		this.seekRange.addEventListener("input", () => {
			this.isSeeking = true;
			this.renderProgress();
		});
		this.seekRange.addEventListener("change", () => {
			const target = Number(this.seekRange.value);
			this.isSeeking = false;
			this.plugin.seekPlayback(target);
		});
		const timeRow = this.trackStatus.createDiv({ cls: "mlp-progress-times" });
		this.elapsedTime = timeRow.createSpan();
		this.remainingTime = timeRow.createSpan();
		this.totalTime = timeRow.createSpan();
		this.updateProgressLabels();

		const titleRow = this.root.createDiv({ cls: "mlp-title-row" });
		this.titleButton = titleRow.createEl("button", { cls: "mlp-current-title" });
		this.titleButton.addEventListener("click", () => {
			const queue = this.plugin.getQueue();
			const index = queue.findIndex((track) => track.id === this.plugin.currentTrackId);
			const track = index >= 0 ? queue[index] : undefined;
			if (track?.kind === "youtube") this.plugin.refreshYoutubeTitle(track);
			if (track) new NamePromptModal(
				this.app,
				this.plugin.tr("renameTrack"),
				(name) => void this.plugin.renameTrack(track.id, name),
				this.plugin.tr("ok"),
				this.plugin.getDisplayTitle(track),
			).open();
		});
		this.youtubeToggleButton = this.addIconButton(titleRow, "eye", "showYoutube", () => {
			if (this.youtubeSection.hasClass("is-hidden")) this.plugin.showCurrentYoutubePreview();
			else this.plugin.closeYoutubePreview();
		});
		this.youtubeToggleButton.addClass("is-hidden");

		this.youtubeSection = this.root.createDiv({ cls: "mlp-youtube-section is-hidden" });
		const youtubeHeader = this.youtubeSection.createDiv({ cls: "mlp-youtube-header" });
		this.youtubeLabel = youtubeHeader.createDiv({ cls: "mlp-youtube-label" });
		this.addIconButton(youtubeHeader, "x", "hideYoutube", () => this.plugin.closeYoutubePreview());
		this.youtubeHost = this.youtubeSection.createDiv({ cls: "mlp-youtube-host is-hidden" });
		this.youtubeError = this.youtubeSection.createDiv({ cls: "mlp-youtube-error is-hidden" });

		const actions = this.root.createDiv({ cls: "mlp-actions" });
		this.addIconButton(actions, "file-plus-2", "addFile", () => void this.pickExternalFiles());
		this.addIconButton(actions, "file-plus", "addVaultFile", () => new VaultFileSuggestModal(this.app, (file) => void this.plugin.addVaultFile(file)).open());
		this.addIconButton(actions, "folder-plus", "addFolder", () => void this.pickExternalFolder());
		this.addIconButton(actions, "folder-open", "addVaultFolder", () => new VaultFolderSuggestModal(this.app, (folder) => void this.plugin.addVaultFolder(folder)).open());
		this.addIconButton(actions, "refresh-cw", "reindex", () => void this.plugin.reindexSources());
		this.addIconButton(actions, "list-plus", "createPlaylist", () => new NamePromptModal(this.app, this.plugin.tr("chooseName"), (name) => void this.plugin.addPlaylist(name), this.plugin.tr("ok")).open());
		this.addIconButton(actions, "layers-2", "createCollection", () => new NamePromptModal(this.app, this.plugin.tr("chooseName"), (name) => void this.plugin.addCollection(name), this.plugin.tr("ok")).open());

		this.linkForm = this.root.createDiv({ cls: "mlp-youtube-link-form is-hidden" });
		this.urlInput = this.linkForm.createEl("input", { attr: { type: "url", placeholder: this.plugin.tr("youtubeUrl") } });
		const addYoutubeFromInput = (): void => {
			const value = this.urlInput.value;
			void this.plugin.addYoutubeLink(value).then((added) => { if (added) this.urlInput.value = ""; });
		};
		this.urlInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			addYoutubeFromInput();
		});
		this.addIconButton(this.linkForm, "link-2", "addYoutube", addYoutubeFromInput);

		this.collectionPanel = this.root.createDiv({ cls: "mlp-collection-panel is-hidden" });
		this.libraryList = this.root.createDiv({ cls: "mlp-library-list is-hidden" });
		this.onlineList = this.libraryList.createDiv({ cls: "mlp-online-list" });
		this.localTracksTitle = this.libraryList.createEl("h4", { text: this.plugin.tr("localTracks") });
		this.localTracksTitle.dataset.i18n = "localTracks";
		this.trackList = this.libraryList.createDiv({ cls: "mlp-track-list" });
	}

	private addIconButton(parent: HTMLElement, icon: string, labelKey: Parameters<MusicPlayerPlugin["tr"]>[0], action: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "mlp-icon-button" });
		button.dataset.i18n = labelKey;
		button.setAttribute("aria-label", this.plugin.tr(labelKey));
		button.setAttribute("title", this.plugin.tr(labelKey));
		setIcon(button, icon);
		button.addEventListener("click", action);
		return button;
	}

	refreshLocale(): void {
		this.root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
			const key = element.dataset.i18n as Parameters<MusicPlayerPlugin["tr"]>[0] | undefined;
			if (!key) return;
			if (element instanceof HTMLButtonElement && element.hasClass("mlp-icon-button")) {
				element.setAttribute("aria-label", this.plugin.tr(key));
				element.setAttribute("title", this.plugin.tr(key));
			} else element.setText(this.plugin.tr(key));
		});
		this.urlInput.placeholder = this.plugin.tr("youtubeUrl");
		this.updateProgressLabels();
		this.render();
	}

	private updateProgressLabels(): void {
		this.seekRange.setAttribute("aria-label", this.plugin.tr("seekTrack"));
		this.elapsedTime.setAttribute("title", this.plugin.tr("elapsedTime"));
		this.remainingTime.setAttribute("title", this.plugin.tr("remainingTime"));
		this.totalTime.setAttribute("title", this.plugin.tr("totalTime"));
	}

	private async pickExternalFiles(): Promise<void> {
		const files = await this.plugin.openFileDialog();
		if (files.length) await this.plugin.addExternalFiles(files);
	}

	private async pickExternalFolder(): Promise<void> {
		const folder = await this.plugin.openFolderDialog();
		if (folder) await this.plugin.addExternalFolder(folder);
	}

	render(): void {
		if (!this.root) return;
		this.root.dataset.palette = this.plugin.settings.palette;
		this.root.dataset.appearance = this.plugin.settings.appearance;
		this.contentEl.dataset.appearance = this.plugin.settings.appearance;
		this.renderQueueSelector();
		this.renderModes();
		this.volumeRange.value = String(Math.round(this.plugin.settings.volume * 100));
		this.localStatus.setText(navigator.onLine ? this.plugin.tr("online") : this.plugin.tr("offline"));
		this.localStatus.toggleClass("is-offline", !navigator.onLine);
		this.linkForm.toggleClass("is-hidden", !this.plugin.settings.youtubeEnabled || !navigator.onLine);
		if (!this.plugin.settings.youtubeEnabled || !navigator.onLine) this.hideYoutubePreview();
		this.titleButton.toggleClass("mlp-title-scroll", this.plugin.settings.scrollTitle);
		this.renderCollectionManager();
		this.renderOnlineTracks();
		this.renderLocalTracks();
		this.syncLibraryVisibility();
		this.renderTrackState();
	}

	private syncLibraryVisibility(): void {
		const hasQueueView = this.plugin.settings.queueSelection !== "all";
		this.libraryListButton.toggleClass("is-hidden", hasQueueView);
		this.libraryList.toggleClass("is-hidden", hasQueueView || !this.libraryListOpen);
	}

	private renderQueueSelector(): void {
		const current = this.plugin.settings.queueSelection;
		this.queueSelect.empty();
		this.addOption(this.queueSelect, "all", this.plugin.tr("allTracks"));
		for (const playlist of this.plugin.settings.playlists) this.addOption(this.queueSelect, `playlist:${playlist.id}`, `${this.plugin.tr("playlists")}: ${playlist.name}`);
		for (const collection of this.plugin.settings.collections) this.addOption(this.queueSelect, `collection:${collection.id}`, `${this.plugin.tr("collections")}: ${collection.name}`);
		if (![...this.queueSelect.options].some((option) => option.value === current)) this.queueSelect.value = "all";
		else this.queueSelect.value = current;
	}

	private renderModes(): void {
		const mode = this.plugin.settings.playbackMode;
		const icon = mode === "repeat" ? "repeat-2" : mode === "random" ? "shuffle" : "list-ordered";
		const label: Parameters<MusicPlayerPlugin["tr"]>[0] = mode === "repeat" ? "modeRepeat" : mode === "random" ? "modeRandom" : "modeSequential";
		this.modeButton.empty();
		setIcon(this.modeButton, icon);
		this.modeButton.setAttribute("aria-label", this.plugin.tr(label));
		this.modeButton.setAttribute("title", this.plugin.tr(label));
	}
	private addOption(select: HTMLSelectElement, value: string, label: string): void {
		select.createEl("option", { value, text: label });
	}

	private renderCollectionManager(): void {
		this.collectionPanel.empty();
		const playlist = this.plugin.settings.queueSelection.startsWith("playlist:")
			? this.plugin.settings.playlists.find((item) => item.id === this.plugin.settings.queueSelection.slice(9))
			: undefined;
		const selected = this.plugin.settings.queueSelection.startsWith("collection:")
			? this.plugin.settings.collections.find((item) => item.id === this.plugin.settings.queueSelection.slice(11))
			: undefined;
		this.collectionPanel.toggleClass("is-hidden", !selected && !playlist);
		if (playlist) {
			const header = this.collectionPanel.createDiv({ cls: "mlp-collection-header" });
			header.createEl("h4", { text: playlist.name });
			const body = this.collectionPanel.createDiv({ cls: "mlp-collection-body" });
			this.addDisclosureButton(header, `playlist:${playlist.id}`, body);
			this.addPlaylistTrackPicker(header, playlist);
			this.addPlaylistFolderPicker(header, playlist, false);
			this.addPlaylistFolderPicker(header, playlist, true);
			const removePlaylist = this.addQuietIcon(header, "trash-2", "removePlaylist");
			removePlaylist.addEventListener("click", () => {
				if (window.confirm(this.plugin.tr("confirmDelete"))) void this.plugin.deletePlaylist(playlist.id);
			});
			this.renderPlaylistTracks(body, playlist);
			return;
		}
		if (!selected) return;
		const header = this.collectionPanel.createDiv({ cls: "mlp-collection-header" });
		header.createEl("h4", { text: selected.name });
		const body = this.collectionPanel.createDiv({ cls: "mlp-collection-body" });
		this.addDisclosureButton(header, `collection:${selected.id}`, body);
		const removeCollection = this.addQuietIcon(header, "trash-2", "removeCollection");
		removeCollection.addEventListener("click", () => {
			if (window.confirm(this.plugin.tr("confirmDelete"))) void this.plugin.deleteCollection(selected.id);
		});
		body.createEl("div", { text: this.plugin.tr("manageCollection"), cls: "mlp-manager-label" });
		for (const entry of selected.playlists) {
			const item = this.plugin.settings.playlists.find((candidate) => candidate.id === entry.playlistId);
			if (!item) continue;
			const section = body.createDiv({ cls: "mlp-playlist-section" });
			const row = section.createDiv({ cls: "mlp-playlist-header" });
			row.createEl("h4", { text: item.name });
			const checkbox = row.createEl("input", { cls: "mlp-playlist-enabled", attr: { type: "checkbox" } });
			checkbox.checked = entry.enabled;
			checkbox.setAttribute("title", this.plugin.tr("playlistEnabled"));
			checkbox.setAttribute("aria-label", `${this.plugin.tr("playlistEnabled")}: ${item.name}`);
			checkbox.addEventListener("change", () => void this.plugin.setCollectionPlaylistEnabled(selected, item.id, checkbox.checked));
			const trackBody = section.createDiv({ cls: "mlp-playlist-tracks" });
			this.addDisclosureButton(row, `collection-playlist:${selected.id}:${item.id}`, trackBody);
			this.addPlaylistTrackPicker(row, item);
			this.addPlaylistFolderPicker(row, item, false);
			this.addPlaylistFolderPicker(row, item, true);
			const remove = this.addQuietIcon(row, "x", "removePlaylist");
			remove.addEventListener("click", () => void this.plugin.removeFromCollection(selected, item.id));
			this.renderPlaylistTracks(trackBody, item);
		}
		if (this.plugin.settings.playlists.length) {
			this.addIconButton(body, "list-plus", "addPlaylistToCollection", () => void this.plugin.addPlaylistToAnyCollection());
		}
	}

	private addPlaylistTrackPicker(parent: HTMLElement, playlist: Playlist): void {
		const add = this.addQuietIcon(parent, "plus", "addToPlaylist");
		add.addEventListener("click", () => {
			const tracks: PlayerTrack[] = [
				...this.plugin.settings.tracks,
				...(this.plugin.settings.youtubeEnabled && navigator.onLine ? this.plugin.settings.youtubeTracks : []),
			];
			new PlaylistTrackSuggestModal(this.app, tracks, (track) => void this.plugin.addTrackToPlaylist(track.id, playlist)).open();
		});
	}

	private addPlaylistFolderPicker(parent: HTMLElement, playlist: Playlist, fromVault: boolean): void {
		const key = fromVault ? "addVaultFolderToPlaylist" : "addFolderToPlaylist";
		const button = this.addQuietIcon(parent, fromVault ? "folder-open" : "folder-plus", key);
		button.addEventListener("click", () => {
			if (fromVault) {
				new VaultFolderSuggestModal(this.app, (folder) => void this.plugin.addVaultFolderToPlaylist(folder, playlist)).open();
				return;
			}
			void this.plugin.openFolderDialog().then((folderPath) => {
				if (folderPath) void this.plugin.addExternalFolderToPlaylist(folderPath, playlist);
			});
		});
	}

	private renderPlaylistTracks(parent: HTMLElement, playlist: Playlist): void {
		const tracks = playlist.trackIds.map((id) => this.plugin.getTrack(id)).filter((track): track is PlayerTrack => !!track);
		if (!tracks.length) {
			parent.createDiv({ cls: "mlp-empty", text: this.plugin.tr("noTracks") });
			return;
		}
		const list = parent.createDiv({ cls: "mlp-track-list" });
		tracks.forEach((track, index) => this.renderTrackRow(list, track, track.kind === "youtube", index, playlist));
	}

	private addDisclosureButton(parent: HTMLElement, sectionKey: string, body: HTMLElement): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "mlp-quiet-button mlp-disclosure-button" });
		const update = (): void => {
			const collapsed = this.collapsedSections.has(sectionKey);
			body.toggleClass("is-hidden", collapsed);
			const label = this.plugin.tr(collapsed ? "expandContent" : "collapseContent");
			button.setAttribute("title", label);
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-expanded", String(!collapsed));
			button.empty();
			setIcon(button, collapsed ? "eye" : "eye-off");
		};
		button.addEventListener("click", () => {
			if (this.collapsedSections.has(sectionKey)) this.collapsedSections.delete(sectionKey);
			else this.collapsedSections.add(sectionKey);
			update();
		});
		update();
		return button;
	}
	private addQuietIcon(parent: HTMLElement, icon: string, key: Parameters<MusicPlayerPlugin["tr"]>[0]): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "mlp-quiet-button" });
		button.setAttribute("title", this.plugin.tr(key));
		button.setAttribute("aria-label", this.plugin.tr(key));
		setIcon(button, icon);
		return button;
	}

	private renderOnlineTracks(): void {
		this.onlineList.empty();
		const showOnlineLibrary = this.plugin.settings.queueSelection === "all"
			&& this.plugin.settings.youtubeEnabled
			&& navigator.onLine
			&& this.plugin.settings.youtubeTracks.length > 0;
		this.onlineList.toggleClass("is-hidden", !showOnlineLibrary);
		if (!showOnlineLibrary) return;
		const header = this.onlineList.createDiv({ cls: "mlp-collection-header mlp-section-header" });
		header.createEl("h4", { text: this.plugin.tr("onlineTracks") });
		const tracks = this.onlineList.createDiv({ cls: "mlp-online-track-list" });
		this.addDisclosureButton(header, "youtube-links", tracks);
		for (const track of this.plugin.settings.youtubeTracks) this.renderTrackRow(tracks, track, true);
	}

	private renderLocalTracks(): void {
		this.trackList.empty();
		const showAllLocalTracks = this.plugin.settings.queueSelection === "all";
		this.localTracksTitle.toggleClass("is-hidden", !showAllLocalTracks);
		this.trackList.toggleClass("is-hidden", !showAllLocalTracks);
		if (!showAllLocalTracks) return;
		const tracks = this.plugin.getLocalTracks();
		if (!tracks.length) {
			this.trackList.createDiv({ cls: "mlp-empty", text: this.plugin.tr("noTracks") });
			return;
		}
		tracks.forEach((track, index) => this.renderTrackRow(this.trackList, track, false, index));
	}

	private renderTrackRow(parent: HTMLElement, track: PlayerTrack, isOnline: boolean, index = 0, playlistContext?: Playlist): void {
		const row = parent.createDiv({ cls: "mlp-track-row" });
		row.dataset.trackId = track.id;
		row.toggleClass("is-active", this.plugin.currentTrackId === track.id);
		const fullTitle = this.plugin.getDisplayTitle(track);
		const title = row.createEl("button", { cls: "mlp-track-title", text: fullTitle });
		title.setAttribute("title", fullTitle);
		title.addEventListener("click", () => void this.plugin.playTrack(track.id));
		if (track.kind === "local") {
			const source = this.plugin.settings.sources.find((item) => item.id === track.sourceId);
			if (source) {
				const sourceButton = row.createEl("button", { cls: "mlp-track-source", text: source.name });
				sourceButton.setAttribute("title", `${this.plugin.tr("revealInFolder")}: ${source.path}`);
				sourceButton.setAttribute("aria-label", `${this.plugin.tr("revealInFolder")}: ${fullTitle}`);
				sourceButton.addEventListener("click", () => void this.plugin.revealLocalTrack(track));
			}
		}
		if (playlistContext) {
			const position = row.createSpan({ cls: "mlp-track-position", text: String(index + 1) });
			position.setAttribute("aria-hidden", "true");
		}
		const actions = row.createDiv({ cls: "mlp-track-actions" });
		const selectedPlaylist = playlistContext ?? (this.plugin.settings.queueSelection.startsWith("playlist:")
			? this.plugin.settings.playlists.find((playlist) => playlist.id === this.plugin.settings.queueSelection.slice(9))
			: undefined);
		const isInSelectedPlaylist = !!selectedPlaylist?.trackIds.includes(track.id);
		const add = this.addQuietIcon(actions, isInSelectedPlaylist ? "minus" : "plus", isInSelectedPlaylist ? "removeFromPlaylist" : "addToPlaylist");
		add.addEventListener("click", () => {
			if (playlistContext) {
				if (isInSelectedPlaylist) void this.plugin.removeTrackFromPlaylist(track.id, playlistContext);
				else void this.plugin.addTrackToPlaylist(track.id, playlistContext);
			} else void this.plugin.addTrackToAnyPlaylist(track);
		});
		if (track.kind === "youtube" && selectedPlaylist) {
			const addElsewhere = this.addQuietIcon(actions, "list-plus", "addToAnotherPlaylist");
			addElsewhere.addEventListener("click", () => void this.plugin.addTrackToAnyPlaylist(track, true));
		}
		const remove = this.addQuietIcon(actions, "trash-2", isOnline ? "removeLink" : "removeFromIndex");
		remove.addEventListener("click", () => {
			if (window.confirm(this.plugin.tr("confirmDelete"))) void this.plugin.removeTrack(track);
		});
	}

		renderTrackState(): void {
		if (!this.titleButton) return;
		const queue = this.plugin.getQueue();
		const index = queue.findIndex((track) => track.id === this.plugin.currentTrackId);
		const track = index >= 0 ? queue[index] : undefined;
		this.renderCurrentTitle(track);
		this.playButton.empty();
		const icon = this.plugin.isPlaying ? "pause" : "play";
		this.playButton.dataset.i18n = this.plugin.isPlaying ? "pause" : "play";
		this.playButton.setAttribute("aria-label", this.plugin.tr(this.plugin.isPlaying ? "pause" : "play"));
		this.playButton.setAttribute("title", this.plugin.tr(this.plugin.isPlaying ? "pause" : "play"));
		setIcon(this.playButton, icon);
		this.root.querySelectorAll<HTMLElement>(".mlp-track-row").forEach((row) => row.toggleClass("is-active", row.dataset.trackId === track?.id));
		this.updateYoutubeToggle();
		this.renderProgress();
	}

	private renderCurrentTitle(track: PlayerTrack | undefined): void {
		const fullTitle = track ? this.plugin.getDisplayTitle(track) : this.plugin.tr("pluginName");
		const scroll = !!track && this.plugin.settings.scrollTitle;
		const key = `${track?.id ?? ""}\u0000${fullTitle}\u0000${scroll}`;
		if (this.renderedTitleKey === key) return;
		this.renderedTitleKey = key;
		this.titleAnimation?.cancel();
		this.titleAnimation = null;
		this.titleAnimationDistance = 0;
		this.titleButton.empty();
		const renameHint = this.plugin.tr("renameTrack");
		this.titleButton.setAttribute("title", `${fullTitle} · ${renameHint}`);
		this.titleButton.setAttribute("aria-label", `${fullTitle} · ${renameHint}`);
		this.titleButton.toggleClass("mlp-title-scroll", scroll);
		if (!scroll) {
			this.titleButton.createSpan({ cls: "mlp-title-static", text: track ? this.truncate(fullTitle, 40) : fullTitle });
			return;
		}
		const marquee = this.titleButton.createSpan({ cls: "mlp-title-marquee", attr: { "aria-hidden": "true" } });
		marquee.createSpan({ cls: "mlp-title-copy", text: fullTitle });
		marquee.createSpan({ cls: "mlp-title-copy", text: fullTitle });
		window.requestAnimationFrame(() => this.ensureTitleAnimation());
	}

	private ensureTitleAnimation(): void {
		if (!this.titleButton || !this.plugin.settings.scrollTitle) return;
		const marquee = this.titleButton.querySelector<HTMLElement>(".mlp-title-marquee");
		const firstCopy = marquee?.querySelector<HTMLElement>(".mlp-title-copy");
		if (!marquee || !firstCopy) return;
		const distance = firstCopy.getBoundingClientRect().width;
		if (!shouldRestartMarquee(this.titleButton.clientWidth, distance, this.titleAnimationDistance, this.titleAnimation?.playState)) return;
		this.titleAnimation?.cancel();
		this.titleAnimationDistance = distance;
		this.titleAnimation = marquee.animate(
			[{ transform: "translateX(0px)" }, { transform: `translateX(${-distance}px)` }],
			{ duration: marqueeDuration(distance), iterations: Infinity, easing: "linear" },
		);
	}

	private updateYoutubeToggle(): void {
		if (!this.youtubeToggleButton) return;
		const track = this.plugin.currentTrackId ? this.plugin.getTrack(this.plugin.currentTrackId) : null;
		const available = track?.kind === "youtube" && this.plugin.settings.youtubeEnabled && navigator.onLine;
		this.youtubeToggleButton.toggleClass("is-hidden", !available);
		if (!available) return;
		const visible = !this.youtubeSection.hasClass("is-hidden");
		const key = visible ? "hideYoutube" : "showYoutube";
		this.youtubeToggleButton.dataset.i18n = key;
		this.youtubeToggleButton.setAttribute("title", this.plugin.tr(key));
		this.youtubeToggleButton.setAttribute("aria-label", this.plugin.tr(key));
		this.youtubeToggleButton.empty();
		setIcon(this.youtubeToggleButton, visible ? "eye-off" : "eye");
	}

	renderProgress(): void {
		if (!this.seekRange) return;
		if (this.progressTrackId !== this.plugin.currentTrackId) {
			this.progressTrackId = this.plugin.currentTrackId;
			this.isSeeking = false;
		}
		const { elapsed, duration } = this.plugin.getPlaybackProgress();
		const canSeek = duration > 0;
		this.seekRange.disabled = !canSeek;
		this.seekRange.max = String(canSeek ? duration : 1);
		if (!this.isSeeking || !canSeek) this.seekRange.value = String(canSeek ? elapsed : 0);
		const displayedElapsed = this.isSeeking && canSeek ? Number(this.seekRange.value) : elapsed;
		this.elapsedTime.setText(this.formatTime(displayedElapsed));
		this.remainingTime.setText(canSeek ? `−${this.formatTime(Math.max(0, duration - displayedElapsed))}` : "--:--");
		this.totalTime.setText(canSeek ? this.formatTime(duration) : "--:--");
		this.seekRange.setAttribute("aria-valuetext", canSeek ? `${this.formatTime(displayedElapsed)} / ${this.formatTime(duration)}` : "--:--");
		this.trackStatus.toggleClass("is-playing", this.plugin.isPlaying && !!this.plugin.currentTrackId);
	}

	private formatTime(seconds: number): string {
		const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const remainder = String(total % 60).padStart(2, "0");
		return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
	}

	private truncate(value: string, limit: number): string {
		const chars = Array.from(value);
		return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : value;
	}

	getYoutubeHost(): HTMLElement {
		const id = "music-library-player-youtube-host";
		return this.youtubeHost.querySelector<HTMLElement>(`#${id}`) ?? this.youtubeHost.createDiv({ attr: { id } });
	}

	setYoutubeLabel(value: string): void {
		this.youtubeLabel.setText(value);
		this.youtubeSection.removeClass("is-hidden");
		this.youtubeError.addClass("is-hidden");
		this.youtubeHost.removeClass("is-hidden");
		this.updateYoutubeToggle();
	}

	updateYoutubeLabel(value: string): void {
		this.youtubeLabel.setText(value);
	}

	showYoutubeError(message: string, fallback: LocalTrack | undefined, onSwitch: () => void): void {
		this.youtubeSection.removeClass("is-hidden");
		this.youtubeHost.addClass("is-hidden");
		this.youtubeError.empty();
		this.youtubeError.removeClass("is-hidden");
		this.youtubeError.createSpan({ text: message });
		this.addIconButton(this.youtubeError, "hard-drive", fallback ? "switchToLocal" : "chooseLocalTrack", onSwitch);
		this.updateYoutubeToggle();
	}

	hideYoutubePreview(): void {
		this.youtubeSection.addClass("is-hidden");
		this.youtubeHost.addClass("is-hidden");
		this.youtubeError.addClass("is-hidden");
		this.updateYoutubeToggle();
	}
}

export class NamePromptModal extends Modal {
	constructor(app: MusicPlayerPlugin["app"], private readonly placeholder: string, private readonly onSubmit: (value: string) => void, private readonly okLabel: string, private readonly initialValue = "") { super(app); }
	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.placeholder });
		const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: this.placeholder } });
		input.value = this.initialValue;
		input.select();
		input.focus();
		const button = this.contentEl.createEl("button", { text: this.okLabel, cls: "mod-cta" });
		button.addEventListener("click", () => {
			const value = input.value.trim();
			if (value) { this.onSubmit(value); this.close(); }
		});
		input.addEventListener("keydown", (event) => { if (event.key === "Enter") button.click(); });
	}
	onClose(): void { this.contentEl.empty(); }
}

export class TrackInfoModal extends Modal {
	constructor(app: MusicPlayerPlugin["app"], private readonly label: string, private readonly index: number, private readonly fullTitle: string) { super(app); }
	onOpen(): void {
		this.contentEl.createEl("h4", { text: `${this.label} ${this.index}` });
		this.contentEl.createEl("p", { text: this.fullTitle });
	}
	onClose(): void { this.contentEl.empty(); }
}

export class PlaylistSuggestModal extends FuzzySuggestModal<Playlist> {
	constructor(app: MusicPlayerPlugin["app"], private readonly playlists: Playlist[], private readonly onChoose: (playlist: Playlist) => void) { super(app); }
	getItems(): Playlist[] { return this.playlists; }
	getItemText(item: Playlist): string { return item.name; }
	onChooseItem(item: Playlist): void { this.onChoose(item); }
}

export class VaultAudioSuggestModal extends FuzzySuggestModal<LocalTrack> {
	constructor(app: MusicPlayerPlugin["app"], private readonly tracks: LocalTrack[], private readonly onChoose: (track: LocalTrack) => void) { super(app); }
	getItems(): LocalTrack[] { return this.tracks; }
	getItemText(item: LocalTrack): string { return getFullTrackTitle(item); }
	onChooseItem(item: LocalTrack): void { this.onChoose(item); }
}

export class PlaylistTrackSuggestModal extends FuzzySuggestModal<PlayerTrack> {
	constructor(app: MusicPlayerPlugin["app"], private readonly tracks: PlayerTrack[], private readonly onChoose: (track: PlayerTrack) => void) { super(app); }
	getItems(): PlayerTrack[] { return this.tracks; }
	getItemText(item: PlayerTrack): string { return getFullTrackTitle(item); }
	onChooseItem(item: PlayerTrack): void { this.onChoose(item); }
}

export class VaultFolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: MusicPlayerPlugin["app"], private readonly onChoose: (folder: TFolder) => void) { super(app); }
	getItems(): TFolder[] { return this.app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder); }
	getItemText(item: TFolder): string { return item.path || "/"; }
	onChooseItem(item: TFolder): void { this.onChoose(item); }
}

export class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: MusicPlayerPlugin["app"], private readonly onChoose: (file: TFile) => void) { super(app); }
	getItems(): TFile[] { const pattern = new RegExp(`\\.(${AUDIO_EXTENSIONS.join("|")})$`, "i"); return this.app.vault.getFiles().filter((file) => pattern.test(file.path)); }
	getItemText(item: TFile): string { return item.path; }
	onChooseItem(item: TFile): void { this.onChoose(item); }
}
