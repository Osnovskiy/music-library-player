import assert from "node:assert/strict";
import test from "node:test";
import {
	AUDIO_EXTENSIONS,
	countCompletedTasks,
	countNewCompletedTasks,
	ensureYoutubePlaylist,
	extractYoutubeId,
	findRenamedTracks,
	getFullTrackTitle,
	getAudioMimeType,
	getSupportedAudioExtensions,
	isAudioPath,
	matchesNewPattern,
} from "../src/core.mjs";

test("marquee source keeps the complete local filename from older indexes", () => {
	const complete = "Очень длинное название музыкальной композиции без обрезания";
	assert.equal(getFullTrackTitle({ kind: "local", path: `C:\\Music\\${complete}.mp3`, title: "Очень длинное название музыкальной комп…" }), complete);
	assert.equal(getFullTrackTitle({ kind: "local", path: `/Music/${complete}.flac`, title: "Old title" }), complete);
	assert.equal(getFullTrackTitle({ kind: "youtube", title: complete }), complete);
	assert.equal(getFullTrackTitle({ kind: "local", path: "/Music/original.mp3", title: "original", displayTitle: "Custom title" }), "Custom title");
});

test("matches a renamed indexed file back into its old playlist entry", () => {
	const oldTrack = { id: "external:folder/0044-fengshuy.mp3", fileIdentity: "dev:inode-1" };
	const renamedTrack = { id: "external:folder/fengshuy_1.mp3", fileIdentity: "dev:inode-1" };
	assert.deepEqual(findRenamedTracks([oldTrack], [renamedTrack]), [[oldTrack, renamedTrack]]);

	const legacyOldTrack = { id: "external:folder/0044-fengshuy.mp3" };
	const legacyRenamedTrack = { id: "external:folder/fengshuy_1.mp3", fileIdentity: "dev:inode-2" };
	assert.deepEqual(findRenamedTracks([legacyOldTrack], [legacyRenamedTrack]), [[legacyOldTrack, legacyRenamedTrack]]);
	assert.deepEqual(findRenamedTracks([legacyOldTrack, { id: "external:folder/other.mp3" }], [renamedTrack, { id: "external:folder/new.mp3" }]), []);
});

test("accepts supported audio extensions without case sensitivity", () => {
	assert.equal(isAudioPath("C:/Music/track.MP3"), true);
	assert.equal(isAudioPath("C:/Music/track.WaV"), true);
	assert.equal(isAudioPath("C:/Music/track.opus"), true);
	assert.equal(isAudioPath("C:/Music/track.mid"), false);
	assert.equal(isAudioPath("C:/Music/track.mp4"), true);
	assert.equal(isAudioPath("C:/Music/track.CAF"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("m4a"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("mpeg"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("caf"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("m4b"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("weba"), true);
	assert.equal(AUDIO_EXTENSIONS.includes("eac3"), true);
	assert.equal(getAudioMimeType("C:/Music/track.eac3"), "audio/mp4; codecs=\"ec-3\"");
	assert.equal(getAudioMimeType("C:/Music/track.opus"), "audio/ogg");
});

test("detects native audio formats using the embedded browser capability", () => {
	const supported = getSupportedAudioExtensions((mime) => mime === "audio/mpeg" || mime === "audio/wav" ? "probably" : "");
	assert.deepEqual(supported, ["mp3", "mpeg", "wav"]);
	assert.deepEqual(getSupportedAudioExtensions(() => "no"), []);
});

test("extracts YouTube IDs from common video URLs and rejects unrelated hosts", () => {
	const videoId = "abcdefghijk";
	assert.equal(extractYoutubeId(`https://www.youtube.com/watch?v=${videoId}&list=PL123`), videoId);
	assert.equal(extractYoutubeId(`www.youtube.com/watch?v=${videoId}`), videoId);
	assert.equal(extractYoutubeId(`https://youtu.be/${videoId}?t=12`), videoId);
	assert.equal(extractYoutubeId(`https://youtube.com/shorts/${videoId}`), videoId);
	assert.equal(extractYoutubeId(`https://music.youtube.com/watch?v=${videoId}`), videoId);
	assert.equal(extractYoutubeId(`https://youtube.com.evil.example/watch?v=${videoId}`), null);
	assert.equal(extractYoutubeId("not a URL"), null);
	assert.equal(extractYoutubeId("https://youtu.be/short"), null);
});

test("migrates saved YouTube links once and preserves later playlist removals", () => {
	const playlists = [];
	const links = [{ id: "youtube:abcdefghijk" }, { id: "youtube:lmnopqrstuv" }];
	const playlist = ensureYoutubePlaylist(playlists, links, true);
	assert.equal(playlist.name, "YouTube");
	assert.deepEqual(playlist.trackIds, links.map((link) => link.id));
	playlist.trackIds.shift();
	assert.equal(ensureYoutubePlaylist(playlists, links, false), playlist);
	assert.deepEqual(playlist.trackIds, [links[1].id]);
	assert.equal(playlists.length, 1);
});

test("counts completed Markdown task checkboxes", () => {
	const markdown = [
		"- [x] done",
		"  * [X] also done",
		"+ [ ] not done",
		"1. [x] numbered done",
		"text [x] inline is not a task",
	].join("\n");
	assert.equal(countCompletedTasks(markdown), 3);
	assert.equal(countNewCompletedTasks("- [ ] first\n- [ ] second", "- [x] first\n- [X] second"), 2);
	assert.equal(countNewCompletedTasks("- [x] already done", "- [ ] reopened"), 0);
});

test("manual patterns fire only when a match first appears", () => {
	assert.equal(matchesNewPattern("TODO", "ordinary note", "TODO: new action"), true);
	assert.equal(matchesNewPattern("TODO", "TODO: already here", "TODO: still here"), false);
	assert.equal(matchesNewPattern("TODO", "ordinary note", "still ordinary"), false);
	assert.equal(matchesNewPattern("[", "before", "after ["), false);
});
