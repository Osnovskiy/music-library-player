export const AUDIO_MIME_TYPES = Object.freeze({
	mp3: ["audio/mpeg", "audio/mp3"],
	mpeg: ["audio/mpeg"],
	opus: ['audio/ogg; codecs="opus"', 'audio/webm; codecs="opus"'],
	ogg: ['audio/ogg; codecs="vorbis"', "audio/ogg"],
	oga: ['audio/ogg; codecs="vorbis"', "audio/ogg"],
	wav: ['audio/wav; codecs="1"', "audio/wav", "audio/x-wav"],
	aac: ["audio/aac", "audio/aacp"],
	caf: ["audio/x-caf", "audio/caf"],
	m4a: ["audio/x-m4a", "audio/m4a", "audio/aac", "audio/mp4"],
	m4b: ["audio/x-m4b", "audio/m4b", "audio/aac", "audio/mp4"],
	mp4: ["audio/x-mp4", "audio/mp4", "audio/aac"],
	weba: ['audio/webm; codecs="vorbis"', "audio/webm"],
	webm: ['audio/webm; codecs="vorbis"', "audio/webm"],
	ec3: ['audio/mp4; codecs="ec-3"'],
	eac3: ['audio/mp4; codecs="ec-3"'],
	flac: ["audio/x-flac", "audio/flac"],
});

export const AUDIO_EXTENSIONS = Object.freeze(Object.keys(AUDIO_MIME_TYPES));

export function getFullTrackTitle(track) {
	if (track.displayTitle) return track.displayTitle;
	if (track.kind !== "local") return track.title;
	const filename = track.path.split(/[\\/]/).pop() ?? "";
	const dot = filename.lastIndexOf(".");
	return (dot > 0 ? filename.slice(0, dot) : filename) || track.title;
}

export function findRenamedTracks(previous, discovered) {
	const discoveredIds = new Set(discovered.map((track) => track.id));
	const previousIds = new Set(previous.map((track) => track.id));
	const removed = previous.filter((track) => !discoveredIds.has(track.id));
	const added = discovered.filter((track) => !previousIds.has(track.id));
	const pairs = [];
	const usedRemoved = new Set();
	const usedAdded = new Set();
	const removedByIdentity = new Map();
	const addedByIdentity = new Map();
	for (const track of removed) {
		if (track.fileIdentity) removedByIdentity.set(track.fileIdentity, (removedByIdentity.get(track.fileIdentity) ?? 0) + 1);
	}
	for (const track of added) {
		if (track.fileIdentity) addedByIdentity.set(track.fileIdentity, (addedByIdentity.get(track.fileIdentity) ?? 0) + 1);
	}
	for (const oldTrack of removed) {
		const identity = oldTrack.fileIdentity;
		if (!identity || removedByIdentity.get(identity) !== 1 || addedByIdentity.get(identity) !== 1) continue;
		const newTrack = added.find((track) => track.fileIdentity === identity);
		if (newTrack) {
			pairs.push([oldTrack, newTrack]);
			usedRemoved.add(oldTrack);
			usedAdded.add(newTrack);
		}
	}
	const unmatchedRemoved = removed.filter((track) => !usedRemoved.has(track));
	const unmatchedAdded = added.filter((track) => !usedAdded.has(track));
	// Older indexes did not store filesystem identity; map only the unambiguous one-old/one-new case.
	if (unmatchedRemoved.length === 1 && unmatchedAdded.length === 1 && !unmatchedRemoved[0].fileIdentity) {
		pairs.push([unmatchedRemoved[0], unmatchedAdded[0]]);
	}
	return pairs;
}

const audioExtensionSet = new Set(AUDIO_EXTENSIONS);

export function isAudioPath(filePath) {
	const extension = filePath.split(".").pop()?.toLowerCase();
	return extension !== undefined && audioExtensionSet.has(extension);
}

export function getAudioMimeType(filePath) {
	const extension = filePath.split(".").pop()?.toLowerCase();
	if (extension === "ogg" || extension === "oga" || extension === "opus") return "audio/ogg";
	if (extension === "weba" || extension === "webm") return "audio/webm";
	return extension ? AUDIO_MIME_TYPES[extension]?.[0] ?? "application/octet-stream" : "application/octet-stream";
}

export function getSupportedAudioExtensions(canPlayType) {
	return AUDIO_EXTENSIONS.filter((extension) =>
		AUDIO_MIME_TYPES[extension].some((mimeType) => {
			try {
				const support = canPlayType(mimeType);
				return support !== "" && support !== "no";
			} catch {
				return false;
			}
		}),
	);
}

export function extractYoutubeId(rawUrl) {
	try {
		const input = rawUrl.trim();
		const address = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(input) ? `https://${input}` : input;
		const url = new URL(address);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		if (!(host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com"))) return null;
		let id = "";
		if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? "";
		else if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
		else {
			const parts = url.pathname.split("/").filter(Boolean);
			id = parts[parts.length - 1] ?? "";
		}
		return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
	} catch {
		return null;
	}
}

export function ensureYoutubePlaylist(playlists, youtubeTracks, includeExisting = false) {
	let playlist = playlists.find((item) => item.id === "youtube")
		?? playlists.find((item) => item.name.toLowerCase() === "youtube");
	if (!playlist) {
		playlist = { id: "youtube", name: "YouTube", trackIds: [] };
		playlists.push(playlist);
	}
	if (includeExisting) {
		const known = new Set(playlist.trackIds);
		for (const track of youtubeTracks) {
			if (!known.has(track.id)) {
				playlist.trackIds.push(track.id);
				known.add(track.id);
			}
		}
	}
	return playlist;
}

export function countCompletedTasks(markdown) {
	return (markdown.match(/^\s*(?:[-*+]\s+|\d+\.\s+)\[[xX]\]/gm) ?? []).length;
}

export function countNewCompletedTasks(previous, next) {
	return Math.max(0, countCompletedTasks(next) - countCompletedTasks(previous));
}

export function matchesNewPattern(patternText, previous, next) {
	try {
		const pattern = new RegExp(patternText, "m");
		return !pattern.test(previous) && pattern.test(next);
	} catch {
		return false;
	}
}
