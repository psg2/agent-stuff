/**
 * Git Status Extension
 *
 * Replicates the default footer exactly, but adds git dirty/clean
 * indicators (staged, modified, untracked counts) next to the branch name.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI): void {
	let gitStatusSuffix = "";

	async function refreshGitStatus(): Promise<void> {
		try {
			const statusResult = await pi.exec("git", ["status", "--porcelain"]);
			const lines = statusResult.stdout.trim().split("\n").filter(Boolean);

			let staged = 0;
			let modified = 0;
			let untracked = 0;

			for (const line of lines) {
				const index = line[0];
				const worktree = line[1];
				if (index && index !== " " && index !== "?") staged++;
				if (worktree === "M" || worktree === "D") modified++;
				if (index === "?") untracked++;
			}

			const parts: string[] = [];
			if (staged > 0) parts.push(`+${staged}`);
			if (modified > 0) parts.push(`~${modified}`);
			if (untracked > 0) parts.push(`?${untracked}`);
			if (parts.length === 0) parts.push("✓");

			gitStatusSuffix = ` ${parts.join(" ")}`;
		} catch {
			gitStatusSuffix = "";
		}
	}

	function formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	}

	function installFooter(
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate(): void {},
				render(width: number): string[] {
					// --- Line 1: CWD + branch (with git status) + session name ---
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

					const branch = footerData.getGitBranch();
					if (branch) {
						const hasChanges =
							gitStatusSuffix.includes("+") ||
							gitStatusSuffix.includes("~") ||
							gitStatusSuffix.includes("?");
						const statusColor = hasChanges ? "warning" : "success";
						const coloredStatus = gitStatusSuffix
							? theme.fg(statusColor, gitStatusSuffix)
							: "";
						pwd = `${theme.fg("dim", `${pwd} (${branch}`)}${coloredStatus}${theme.fg("dim", ")")}`;
					} else {
						pwd = theme.fg("dim", pwd);
					}

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName)
						pwd = `${pwd}${theme.fg("dim", ` • ${sessionName}`)}`;

					// --- Line 2: token stats (left) | model info (right) ---
					// Compute cumulative usage from all session entries
					let totalInput = 0,
						totalOutput = 0,
						totalCacheRead = 0,
						totalCacheWrite = 0,
						totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (
							entry.type === "message" &&
							entry.message.role === "assistant"
						) {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
						}
					}

					// Context percentage from last non-aborted assistant message
					const contextUsage = ctx.getContextUsage();
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextWindow = ctx.model?.contextWindow || 0;

					// Build left side: token stats
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead)
						statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite)
						statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const usingSubscription = ctx.model
						? ctx.modelRegistry.isUsingOAuth(ctx.model)
						: false;
					if (totalCost || usingSubscription) {
						const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
						statsParts.push(costStr);
					}

					// Context percentage with color coding
					let contextPercentStr: string;
					const contextPercentDisplay = `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}`;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);

					if (statsLeftWidth > width) {
						const plainStatsLeft = statsLeft.replace(
							new RegExp("\x1b\\[[0-9;]*m", "g"),
							"",
						);
						statsLeft = `${plainStatsLeft.substring(0, width - 3)}...`;
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// Build right side: provider + model + thinking level
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;

					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}

					let rightSide = rightSideWithoutProvider;
					const minPadding = 2;

					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 3) {
							const plainRightSide = rightSide.replace(
								new RegExp("\x1b\\[[0-9;]*m", "g"),
								"",
							);
							const truncatedPlain = plainRightSide.substring(
								0,
								availableForRight,
							);
							const padding = " ".repeat(
								width - statsLeftWidth - truncatedPlain.length,
							);
							statsLine = statsLeft + padding + truncatedPlain;
						} else {
							statsLine = statsLeft;
						}
					}

					// Apply dim styling
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					// pwd is already styled when branch is present
					const styledPwd = branch ? pwd : theme.fg("dim", pwd);
					const lines = [
						truncateToWidth(styledPwd, width),
						dimStatsLeft + dimRemainder,
					];

					// Extension statuses line
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) =>
								text
									.replace(/[\r\n\t]/g, " ")
									.replace(/ +/g, " ")
									.trim(),
							);
						const statusLine = sortedStatuses.join(" ");
						lines.push(
							truncateToWidth(statusLine, width, theme.fg("dim", "...")),
						);
					}

					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await refreshGitStatus();
		installFooter(ctx);
	});

	pi.on("turn_end", async () => {
		await refreshGitStatus();
	});

	pi.on("session_switch", async (_event, ctx) => {
		await refreshGitStatus();
		installFooter(ctx);
	});
}
