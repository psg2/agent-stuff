/**
 * Bash guard - enforces a default timeout and shows elapsed time on tool executions
 *
 * - Bash commands without an explicit timeout get a default max (120s).
 * - A live elapsed timer is shown in the footer status while tools execute.
 * - Configurable via /bash-timeout <seconds> (0 = no default timeout).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";

const DEFAULT_TIMEOUT = 120;

export default function (pi: ExtensionAPI) {
	let defaultTimeout = DEFAULT_TIMEOUT;

	// Track active tool executions for the elapsed timer
	const activeTools = new Map<string, { name: string; startTime: number }>();
	let timerInterval: ReturnType<typeof setInterval> | null = null;

	// Override bash tool to enforce default timeout.
	// Keep the registered tool metadata from a template instance, but execute
	// against the active session cwd so branch/session switches stay correct.
	const baseBash = createBashTool(process.cwd());

	pi.registerTool({
		...baseBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (defaultTimeout > 0 && !params.timeout) {
				params = { ...params, timeout: defaultTimeout };
			}
			const currentBash = createBashTool(ctx.cwd);
			return currentBash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// Command to adjust timeout at runtime
	pi.registerCommand("bash-timeout", {
		description: "Set default bash timeout in seconds (0 = no limit)",
		handler: async (args, ctx) => {
			const val = parseInt(args.trim(), 10);
			if (isNaN(val) || val < 0) {
				ctx.ui.notify(`Current default bash timeout: ${defaultTimeout}s. Usage: /bash-timeout <seconds>`, "info");
				return;
			}
			defaultTimeout = val;
			ctx.ui.notify(
				val === 0 ? "Default bash timeout disabled." : `Default bash timeout set to ${val}s.`,
				"info",
			);
		},
	});

	// Elapsed time tracking
	function formatElapsed(ms: number): string {
		const secs = Math.floor(ms / 1000);
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		const remainSecs = secs % 60;
		return `${mins}m${remainSecs.toString().padStart(2, "0")}s`;
	}

	function updateStatus(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void; theme: any } }) {
		if (activeTools.size === 0) {
			ctx.ui.setStatus("bash-guard", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const now = Date.now();
		const parts: string[] = [];

		for (const [, info] of activeTools) {
			const elapsed = formatElapsed(now - info.startTime);
			const name = info.name === "Bash" ? "⏱" : info.name;
			parts.push(`${name} ${elapsed}`);
		}

		const text = parts.join(theme.fg("dim", " │ "));
		ctx.ui.setStatus("bash-guard", text);
	}

	function startTimer(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void; theme: any } }) {
		if (!timerInterval) {
			timerInterval = setInterval(() => updateStatus(ctx), 1000);
		}
	}

	function stopTimer(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void; theme: any } }) {
		if (timerInterval && activeTools.size === 0) {
			clearInterval(timerInterval);
			timerInterval = null;
			ctx.ui.setStatus("bash-guard", undefined);
		}
	}

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.set(event.toolCallId, {
			name: event.toolName.charAt(0).toUpperCase() + event.toolName.slice(1),
			startTime: Date.now(),
		});
		startTimer(ctx);
		updateStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const info = activeTools.get(event.toolCallId);
		if (info) {
			const elapsed = formatElapsed(Date.now() - info.startTime);
			const theme = ctx.ui.theme;

			// Show final elapsed as a brief notification for long-running commands
			if (Date.now() - info.startTime > 5000) {
				ctx.ui.setStatus(
					"bash-guard",
					theme.fg("dim", `${info.name} completed in ${elapsed}`),
				);
				// Clear after 3 seconds
				setTimeout(() => {
					if (activeTools.size === 0) {
						ctx.ui.setStatus("bash-guard", undefined);
					}
				}, 3000);
			}
		}
		activeTools.delete(event.toolCallId);
		stopTimer(ctx);
	});

	// Clean up on session switch or shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		activeTools.clear();
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
		ctx.ui.setStatus("bash-guard", undefined);
	});
}
