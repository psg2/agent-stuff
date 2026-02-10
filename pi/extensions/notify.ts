/**
 * Pi Notify Extension
 *
 * Sends a BEL character when the agent finishes, triggering the terminal bell.
 * Configure your terminal's bell behavior to get sound/visual notifications.
 *
 * Ghostty: set `bell-features = system,attention,title` in config.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		process.stdout.write("\x07");
	});
}
