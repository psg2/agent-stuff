/**
 * Fix Orphaned Tool Calls
 *
 * When a tool call is interrupted mid-start, the session can end up with
 * a tool_use block in an assistant message but no corresponding tool_result.
 * The Anthropic API requires every tool_use to have a matching tool_result
 * in the next message, so this corrupts the rest of the session.
 *
 * This extension is reactive: it only activates when the specific API error
 * is detected (or orphans are found on session load). On the next request,
 * the context handler injects synthetic aborted tool_result messages.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-ai";

const ERROR_PATTERN = /`tool_use` ids were found without `tool_result`/;

function hasOrphanedToolCalls(messages: AgentMessage[]): boolean {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const toolCallIds = new Set<string>();
		for (const block of msg.content) {
			if (block.type === "toolCall") toolCallIds.add(block.id);
		}
		if (toolCallIds.size === 0) continue;

		for (let j = i + 1; j < messages.length; j++) {
			const next = messages[j];
			if (next.role === "toolResult") {
				toolCallIds.delete(next.toolCallId);
			} else if (next.role === "user" || next.role === "assistant") {
				break;
			}
		}

		if (toolCallIds.size > 0) return true;
	}
	return false;
}

function patchOrphanedToolCalls(messages: AgentMessage[]): { messages: AgentMessage[]; patched: boolean } {
	let patched = false;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const toolCallIds = new Set<string>();
		for (const block of msg.content) {
			if (block.type === "toolCall") toolCallIds.add(block.id);
		}
		if (toolCallIds.size === 0) continue;

		for (let j = i + 1; j < messages.length; j++) {
			const next = messages[j];
			if (next.role === "toolResult") {
				toolCallIds.delete(next.toolCallId);
			} else if (next.role === "user" || next.role === "assistant") {
				break;
			}
		}

		if (toolCallIds.size > 0) {
			const injected: AgentMessage[] = [];
			for (const id of toolCallIds) {
				let toolName = "unknown";
				for (const block of msg.content) {
					if (block.type === "toolCall" && block.id === id) {
						toolName = block.name;
						break;
					}
				}
				injected.push({
					role: "toolResult",
					toolCallId: id,
					toolName,
					content: [{ type: "text", text: "Operation aborted by user." }],
					isError: true,
					timestamp: msg.timestamp,
				});
			}

			messages.splice(i + 1, 0, ...injected);
			i += injected.length;
			patched = true;
		}
	}

	return { messages, patched };
}

export default function (pi: ExtensionAPI) {
	let needsRepair = false;

	// On session load, check for orphaned tool calls.
	// On new/fork, reset the flag (fresh session, no orphans possible).
	// On resume/reload, scan for orphans from a previous interruption.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new" || event.reason === "fork") {
			needsRepair = false;
			return;
		}

		const entries = ctx.sessionManager.getBranch();
		const messages: AgentMessage[] = [];
		for (const entry of entries) {
			if (entry.type === "message") messages.push(entry.message);
		}

		if (hasOrphanedToolCalls(messages)) {
			needsRepair = true;
			ctx.ui.notify("Detected orphaned tool calls from a previous interruption — will auto-fix on next request.", "warning");
		} else {
			needsRepair = false;
		}
	});

	// Detect the specific API error when it happens
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (
			msg.role === "assistant" &&
			msg.stopReason === "error" &&
			msg.errorMessage &&
			ERROR_PATTERN.test(msg.errorMessage)
		) {
			needsRepair = true;
			ctx.ui.notify("Detected orphaned tool call error — will auto-fix on retry.", "warning");
		}
	});

	// Only patch messages when we know there's a problem
	pi.on("context", async (event) => {
		if (!needsRepair) return;

		const { messages, patched } = patchOrphanedToolCalls(event.messages);
		if (patched) {
			return { messages };
		}

		// If we thought we needed repair but found nothing, clear the flag
		needsRepair = false;
	});
}
