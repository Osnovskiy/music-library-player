const modifierCodes = new Set(["Control", "Alt", "Shift", "Meta", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

export function shortcutFromEvent(event: KeyboardEvent): string | null {
	if (event.isComposing || event.getModifierState("AltGraph")) return null;
	const code = event.code || event.key;
	if (!code || code === "Unidentified" || modifierCodes.has(code)) return null;
	const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
	if (!hasModifier && !/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return null;
	return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", code]
		.filter(Boolean).join("+");
}

export function displayShortcut(shortcut: string): string {
	return shortcut.replace(/Key([A-Z])/g, "$1").replace(/Digit([0-9])/g, "$1");
}
