import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type MusicPlayerPlugin from "./main";
import { t } from "./i18n";
import type { ActionEvent, Appearance, BuiltInCue, HotkeyAction, Locale, Palette } from "./types";
import { VaultFileSuggestModal, VaultFolderSuggestModal } from "./view";
import { displayShortcut, shortcutFromEvent } from "./hotkeys";

const eventChoices: ActionEvent[] = ["task-completed", "note-created", "note-modified", "note-renamed", "manual-pattern", "app-started"];
const cueChoices: Array<[BuiltInCue, Parameters<typeof t>[1]]> = [
	["chime", "presetChime"], ["soft", "presetSoft"], ["pop", "presetPop"], ["double", "presetDouble"],
	["click", "presetClick"], ["sonar", "presetSonar"], ["marimba", "presetMarimba"], ["harp", "presetHarp"],
	["notification", "presetNotification"], ["woodblock", "presetWoodblock"], ["complete", "presetComplete"],
	["cashDrawer", "presetCashDrawer"], ["fallingCoin", "presetFallingCoin"],
	["screenKnock", "presetScreenKnock"], ["icqMessage", "presetIcqMessage"],
	["startupAurora", "presetStartupAurora"], ["startupGlass", "presetStartupGlass"],
	["startupWelcome", "presetStartupWelcome"], ["startupRipple", "presetStartupRipple"],
	["startupOrbit", "presetStartupOrbit"], ["monkeySqueal", "presetMonkeySqueal"],
];

export class MusicPlayerSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: MusicPlayerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("mlp-settings");
		containerEl.dataset.palette = this.plugin.settings.palette;
		containerEl.dataset.appearance = this.plugin.settings.appearance;
		const tr = (key: Parameters<typeof t>[1]) => t(this.plugin.settings.locale, key);

		containerEl.createEl("h2", { text: tr("settings") });
		new Setting(containerEl)
			.setName(tr("language"))
			.addDropdown((dropdown) => dropdown
				.addOption("ru", tr("languageRu"))
				.addOption("uk", tr("languageUk"))
				.addOption("en", tr("languageEn"))
				.setValue(this.plugin.settings.locale)
				.onChange(async (value) => {
					this.plugin.settings.locale = value as Locale;
					await this.plugin.saveSettings();
					this.plugin.view?.refreshLocale();
					this.plugin.refreshStatusBar();
					this.display();
				}));

		containerEl.createEl("h3", { text: tr("sourceSettings") });
		new Setting(containerEl)
			.setName(tr("youtubeEnable"))
			.setDesc(tr("youtubeEnableDesc"))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.youtubeEnabled)
				.onChange(async (value) => {
					await this.plugin.toggleYoutube(value);
					this.display();
				}));
		if (this.plugin.settings.youtubeEnabled) {
			new Setting(containerEl)
				.setName(tr("youtubeAutoFallback"))
				.setDesc(tr("youtubeAutoFallbackDesc"))
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.autoSwitchToLastLocal)
					.onChange(async (value) => {
						this.plugin.settings.autoSwitchToLastLocal = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName(tr("autoStart"))
			.setDesc(tr("autoStartDesc"))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoStart)
				.onChange(async (value) => {
					this.plugin.settings.autoStart = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName(tr("scrollTitle"))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.scrollTitle)
				.onChange(async (value) => {
					this.plugin.settings.scrollTitle = value;
					await this.plugin.saveSettings();
					this.plugin.view?.render();
				}));
		new Setting(containerEl)
			.setName(tr("appearance"))
			.addDropdown((dropdown) => dropdown
				.addOption("system", tr("appearanceSystem"))
				.addOption("light", tr("appearanceLight"))
				.addOption("dark", tr("appearanceDark"))
				.setValue(this.plugin.settings.appearance)
				.onChange(async (value) => {
					this.plugin.settings.appearance = value as Appearance;
					containerEl.dataset.appearance = value;
					await this.plugin.saveSettings();
					this.plugin.view?.render();
					this.plugin.refreshStatusBar();
				}));
		new Setting(containerEl)
			.setName(tr("palette"))
			.addDropdown((dropdown) => dropdown
				.addOption("vivid", tr("paletteVivid"))
				.addOption("dark", tr("paletteDark"))
				.addOption("light", tr("paletteLight"))
				.addOption("ocean", tr("paletteOcean"))
				.setValue(this.plugin.settings.palette)
				.onChange(async (value) => {
					this.plugin.settings.palette = value as Palette;
					containerEl.dataset.palette = value;
					await this.plugin.saveSettings();
					this.plugin.view?.render();
					this.plugin.refreshStatusBar();
				}));
		containerEl.createEl("h3", { text: tr("hotkeys") });
		this.addHotkeySetting("playPause", "hotkeyPlayPause");
		this.addHotkeySetting("nextTrack", "hotkeyNext");
		this.addHotkeySetting("previousTrack", "hotkeyPrevious");
		this.addHotkeySetting("openPlayer", "hotkeyOpenPlayer");

		containerEl.createEl("h3", { text: tr("librarySettings") });
		const sourceActions = new Setting(containerEl)
			.setName(tr("sourceSettings"))
			.addButton((button) => this.iconButton(button, "folder-plus", tr("addFolder"), "blue").onClick(async () => {
				const folder = await this.plugin.openFolderDialog();
				if (folder) await this.plugin.addExternalFolder(folder);
				this.display();
			}))
			.addButton((button) => this.iconButton(button, "folder-open", tr("addVaultFolder"), "green").onClick(() => new VaultFolderSuggestModal(this.app, (folder) => {
				void this.plugin.addVaultFolder(folder).then(() => this.display());
			}).open()))
			.addButton((button) => this.iconButton(button, "file-plus", tr("addFile"), "purple").onClick(async () => {
				const files = await this.plugin.openFileDialog();
				if (files.length) await this.plugin.addExternalFiles(files);
				this.display();
			}))
			.addButton((button) => this.iconButton(button, "file-audio", tr("addVaultFile"), "orange").onClick(() => new VaultFileSuggestModal(this.app, (file) => {
				void this.plugin.addVaultFile(file).then(() => this.display());
			}).open()))
			.addButton((button) => this.iconButton(button, "refresh-cw", tr("reindex"), "teal").onClick(async () => {
				await this.plugin.reindexSources();
				this.display();
			}));
		sourceActions.settingEl.addClass("mlp-settings-actions");

		if (this.plugin.settings.sources.length) {
			for (const source of this.plugin.settings.sources) {
				new Setting(containerEl)
					.setName(source.name)
					.setDesc(source.path)
					.addButton((button) => this.iconButton(button, "trash-2", tr("removeFromIndex"), "red").onClick(async () => {
						await this.plugin.removeSource(source.id);
						this.display();
					}));
			}
		} else {
			containerEl.createEl("p", { text: tr("noSources"), cls: "setting-item-description" });
		}

		containerEl.createEl("h3", { text: tr("taskSounds") });
		containerEl.createEl("p", { text: tr("taskSoundsDesc"), cls: "setting-item-description" });
		const eventSelect = containerEl.createEl("select");
		for (const event of eventChoices) eventSelect.createEl("option", { value: event, text: this.eventLabel(event) });
		new Setting(containerEl)
			.setName(tr("addRule"))
			.addButton((button) => this.iconButton(button, "plus", tr("addRule"), "green").onClick(async () => {
				await this.plugin.addRule(eventSelect.value as ActionEvent);
				this.refreshKeepingScroll();
			}));
		for (const rule of this.plugin.settings.taskSoundRules) {
			const setting = new Setting(containerEl)
				.setName(this.eventLabel(rule.event))
				.setDesc(rule.path || (rule.preset ? tr(cueChoices.find(([cue]) => cue === rule.preset)?.[1] ?? "selectSound") : tr("selectSound")))
				.addToggle((toggle) => toggle
					.setValue(rule.enabled)
					.onChange((value) => void this.plugin.updateRule(rule, { enabled: value })))
				.addDropdown((dropdown) => dropdown
					.addOptions(Object.fromEntries(cueChoices.map(([cue, key]) => [cue, tr(key)])))
					.addOption("custom", tr("customSound"))
					.setValue(rule.path ? "custom" : rule.preset ?? "custom")
					.onChange((value) => {
						if (value === "custom") {
							const top = this.settingsScrollContainer().scrollTop;
							void this.plugin.chooseTaskSound(rule).then(() => this.refreshKeepingScroll(top));
						}
						else {
							void this.plugin.updateRule(rule, { preset: value as BuiltInCue, path: "" });
							setting.setDesc(tr(cueChoices.find(([cue]) => cue === value)?.[1] ?? "selectSound"));
						}
					}))
				.addButton((button) => this.iconButton(button, "music-2", tr("selectSound"), "purple").onClick(() => {
					const top = this.settingsScrollContainer().scrollTop;
					void this.plugin.chooseTaskSound(rule).then(() => this.refreshKeepingScroll(top));
				}))
				.addButton((button) => this.iconButton(button, "trash-2", tr("removeRule"), "red").onClick(async () => {
					await this.plugin.removeRule(rule.id);
					this.refreshKeepingScroll();
				}));
			if (rule.event === "manual-pattern") {
				setting.addText((text) => text
					.setPlaceholder(tr("manualPattern"))
					.setValue(rule.pattern ?? "")
					.onChange((value) => void this.plugin.updateRule(rule, { pattern: value })));
			}
		}

		new Setting(containerEl)
			.setName(tr("openGuide"))
			.addButton((button) => this.iconButton(button, "book-open", tr("openGuide"), "blue").onClick(() => void this.plugin.openGuide()));
	}

	private addHotkeySetting(action: HotkeyAction, labelKey: "hotkeyPlayPause" | "hotkeyNext" | "hotkeyPrevious" | "hotkeyOpenPlayer"): void {
		const tr = (key: Parameters<typeof t>[1]) => t(this.plugin.settings.locale, key);
		new Setting(this.containerEl)
			.setName(tr(labelKey))
			.setDesc(tr("hotkeyHint"))
			.addText((text) => {
				text.setPlaceholder(tr("hotkeyRecord")).setValue(displayShortcut(this.plugin.settings.hotkeys[action]));
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mlp-hotkey-input");
				text.inputEl.dataset.hotkey = action;
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Tab") return;
					event.preventDefault();
					event.stopPropagation();
					if (event.key === "Escape") { text.inputEl.blur(); return; }
					if (event.key === "Delete" || event.key === "Backspace") {
						this.plugin.settings.hotkeys[action] = "";
						text.setValue("");
						void this.plugin.saveSettings();
						return;
					}
					const shortcut = shortcutFromEvent(event);
					if (!shortcut) return;
					if (Object.entries(this.plugin.settings.hotkeys).some(([assignedAction, value]) => assignedAction !== action && value === shortcut)) {
						new Notice(tr("hotkeyConflict"));
						return;
					}
					this.plugin.settings.hotkeys[action] = shortcut;
					text.setValue(displayShortcut(shortcut));
					void this.plugin.saveSettings();
				});
			})
			.addButton((button) => this.iconButton(button, "x", tr("hotkeyClear"), "red").onClick(() => {
				this.plugin.settings.hotkeys[action] = "";
				void this.plugin.saveSettings();
				const input = this.containerEl.querySelector<HTMLInputElement>(`.mlp-hotkey-input[data-hotkey="${action}"]`);
				if (input) input.value = "";
			}));
	}

	private settingsScrollContainer(): HTMLElement {
		for (let parent: HTMLElement | null = this.containerEl; parent; parent = parent.parentElement) {
			const overflow = window.getComputedStyle(parent).overflowY;
			if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
		}
		return this.containerEl;
	}

	private refreshKeepingScroll(savedTop?: number): void {
		const scroller = this.settingsScrollContainer();
		const top = savedTop ?? scroller.scrollTop;
		this.display();
		scroller.scrollTop = top;
		window.requestAnimationFrame(() => { scroller.scrollTop = top; });
	}

	private iconButton(button: ButtonComponent, icon: string, label: string, color: string): ButtonComponent {
		button.setIcon(icon).setTooltip(label);
		button.buttonEl.classList.add("mlp-settings-icon-button", `mlp-color-${color}`);
		button.buttonEl.setAttribute("aria-label", label);
		return button;
	}

	private eventLabel(event: ActionEvent): string {
		const key = event === "task-completed" ? "eventTaskCompleted"
			: event === "note-created" ? "eventNoteCreated"
				: event === "note-renamed" ? "eventNoteRenamed"
					: event === "manual-pattern" ? "eventManualPattern" : event === "app-started" ? "eventAppStarted" : "eventNoteModified";
		return t(this.plugin.settings.locale, key);
	}
}
