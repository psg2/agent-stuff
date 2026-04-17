/**
 * Review command - ask the current agent to run an external review round
 *
 * Sends a structured user message that tells the current agent to launch
 * another pi agent in tmux for a second-opinion review.
 *
 * Usage:
 *   /review
 *   /review focus on auth and migrations
 *   /review compare against develop instead of main
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function buildReviewMessage(extraPrompt: string): string {
	const sections = [
		"Run a review round for the current work.",
		"",
		"Use another pi agent in a tmux session for an external second-opinion review.",
		"Review the current branch or diff against the appropriate base branch (usually main unless the repository uses something else).",
		"Focus on correctness, regressions, security issues, and simplification opportunities.",
		"Do not edit files during the review itself.",
		"Report concrete findings only, or say no issues found.",
	];

	if (extraPrompt) {
		sections.push("", `Additional review instructions: ${extraPrompt}`);
	}

	return sections.join("\n");
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Ask the current agent to run an external review round in tmux",
		handler: async (args, ctx) => {
			const message = buildReviewMessage(args.trim());

			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
				return;
			}

			pi.sendUserMessage(message, { deliverAs: "followUp" });
			ctx.ui.notify("Queued /review as a follow-up", "info");
		},
	});
}
