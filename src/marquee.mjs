export function shouldRestartMarquee(viewportWidth, copyWidth, previousWidth, playState) {
	return viewportWidth > 0 && copyWidth > 0
		&& !(playState === "running" && Math.abs(copyWidth - previousWidth) < 1);
}

export function marqueeDuration(copyWidth) {
	return Math.max(8000, copyWidth / 42 * 1000);
}
