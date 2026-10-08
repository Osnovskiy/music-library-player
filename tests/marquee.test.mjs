import assert from "node:assert/strict";
import test from "node:test";
import { marqueeDuration, shouldRestartMarquee } from "../src/marquee.mjs";

test("marquee starts when a previously hidden pane becomes visible", () => {
	assert.equal(shouldRestartMarquee(0, 480, 0), false);
	assert.equal(shouldRestartMarquee(260, 480, 0), true);
	assert.equal(shouldRestartMarquee(260, 480, 480, "running"), false);
	assert.equal(shouldRestartMarquee(260, 510, 480, "running"), true);
	assert.equal(shouldRestartMarquee(260, 480, 480, "idle"), true);
	assert.equal(marqueeDuration(480), 480 / 42 * 1000);
});
