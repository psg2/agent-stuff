/**
 * Ask Tool - Ask clarifying questions to the user
 *
 * Inspired by Claude Code's question interface. Supports:
 * - Single question: simple options list
 * - Multiple questions: breadcrumb navigation with review step
 * - "Type something" option for custom input
 * - "Chat about this" option to provide additional context
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean; isChat?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	allowChat: boolean;
}

interface Answer {
	id: string;
	questionLabel: string;
	value: string;
	label: string;
	wasCustom: boolean;
	wasChat: boolean;
	index?: number;
}

interface AskResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below label" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description:
				"Short contextual label for breadcrumb, e.g. 'Task', 'Scope' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, {
		description: "Available options to choose from",
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow 'Type something' option (default: true)",
		}),
	),
	allowChat: Type.Optional(
		Type.Boolean({
			description: "Allow 'Chat about this' option (default: true)",
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask the user",
	}),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: `Ask the user clarifying questions. Use this when you need input to proceed with a task. Supports multiple questions with a review step before submission.

Example usage:
- Clarifying requirements before implementing a feature
- Getting user preferences for design decisions
- Confirming understanding of a problem before solving it
- Gathering context about the codebase or project`,
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult(
					"Error: UI not available (running in non-interactive mode)",
				);
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
				allowChat: q.allowChat !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = isMulti ? questions.length + 1 : 1; // questions + Submit (only for multi)

			const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode: "other" | "chat" | null = null;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for custom input
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({
							value: "__other__",
							label: "Type something.",
							isOther: true,
						});
					}
					if (q.allowChat) {
						opts.push({
							value: "__chat__",
							label: "Chat about this",
							isChat: true,
						});
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(
					questionId: string,
					questionLabel: string,
					value: string,
					label: string,
					wasCustom: boolean,
					wasChat: boolean,
					index?: number,
				) {
					answers.set(questionId, {
						id: questionId,
						questionLabel,
						value,
						label,
						wasCustom,
						wasChat,
						index,
					});
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const q = questions.find((q) => q.id === inputQuestionId);
					const trimmed = value.trim() || "(no response)";
					const wasChat = inputMode === "chat";
					saveAnswer(
						inputQuestionId,
						q?.label || inputQuestionId,
						trimmed,
						trimmed,
						!wasChat,
						wasChat,
					);
					inputMode = null;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = null;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (
							matchesKey(data, Key.shift("tab")) ||
							matchesKey(data, Key.left)
						) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab (multi-question only)
					if (isMulti && currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = "other";
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						if (opt.isChat) {
							inputMode = "chat";
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(
							q.id,
							q.label,
							opt.value,
							opt.label,
							false,
							false,
							optionIndex + 1,
						);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();

					// Helper to add truncated line
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					// Breadcrumb navigation (multi-question only)
					if (isMulti) {
						const crumbs: string[] = [];
						crumbs.push(theme.fg("dim", "←"));
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const text = ` ${box} ${lbl} `;
							if (isActive) {
								crumbs.push(theme.bg("selectedBg", theme.fg("text", text)));
							} else {
								crumbs.push(theme.fg(isAnswered ? "success" : "muted", text));
							}
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						if (isSubmitTab) {
							crumbs.push(theme.bg("selectedBg", theme.fg("text", submitText)));
						} else {
							crumbs.push(theme.fg(canSubmit ? "success" : "dim", submitText));
						}
						crumbs.push(theme.fg("dim", "→"));
						add(crumbs.join(""));
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						const mainOpts = opts.filter((o) => !o.isChat);
						const chatOpt = opts.find((o) => o.isChat);

						for (let i = 0; i < mainOpts.length; i++) {
							const opt = mainOpts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", ") ") : "  ";
							const color = selected ? "accent" : "text";
							// Mark "Type something" differently when in input mode
							if (isOther && inputMode === "other") {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
							}
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						// Chat option separated at bottom
						if (chatOpt) {
							lines.push("");
							const chatIndex = mainOpts.length;
							const selected = optionIndex === chatIndex;
							const prefix = selected ? theme.fg("accent", ") ") : "  ";
							const color = selected ? "accent" : "muted";
							if (inputMode === "chat") {
								add(
									prefix +
										theme.fg("accent", `${chatIndex + 1}. ${chatOpt.label} ✎`),
								);
							} else {
								add(
									prefix +
										theme.fg(color, `${chatIndex + 1}. ${chatOpt.label}`),
								);
							}
						}
					}

					// Content
					if (inputMode && q) {
						add(theme.fg("text", theme.bold(q.prompt)));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						const prompt = inputMode === "chat" ? " Chat:" : " Your answer:";
						add(theme.fg("muted", prompt));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to cancel"));
					} else if (isMulti && currentTab === questions.length) {
						add(theme.fg("text", theme.bold("Review your answers")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const bullet = theme.fg("success", "● ");
								const qText = theme.fg("text", `${question.prompt}`);
								add(bullet + qText);
								let answerDisplay = answer.label;
								if (answer.wasChat) {
									answerDisplay = `(chat) ${answer.label}`;
								} else if (answer.wasCustom) {
									answerDisplay = `(wrote) ${answer.label}`;
								}
								add(`  → ${theme.fg("accent", answerDisplay)}`);
							}
						}
						lines.push("");
						add(theme.fg("muted", "Ready to submit your answers?"));
						lines.push("");
						const submitSelected = optionIndex === 0;
						const cancelSelected = optionIndex === 1;
						add(
							(submitSelected ? theme.fg("accent", ") ") : "  ") +
								theme.fg(
									submitSelected ? "success" : "text",
									"1. Submit answers",
								),
						);
						add(
							(cancelSelected ? theme.fg("accent", ") ") : "  ") +
								theme.fg(cancelSelected ? "warning" : "text", "2. Cancel"),
						);
					} else if (q) {
						add(theme.fg("text", theme.bold(q.prompt)));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						if (isMulti && currentTab === questions.length) {
							add(theme.fg("dim", " Enter to select • ↑/↓ to navigate"));
						} else if (isMulti) {
							add(
								theme.fg(
									"dim",
									" Enter to select • ↑/↓ to navigate • Tab/←→ questions • Esc to cancel",
								),
							);
						} else {
							add(
								theme.fg(
									"dim",
									" Enter to select • ↑/↓ to navigate • Esc to cancel",
								),
							);
						}
					}

					cachedLines = lines;
					return lines;
				}

				// Handle review tab option selection
				function handleReviewInput(data: string) {
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return true;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(1, optionIndex + 1);
						refresh();
						return true;
					}
					if (matchesKey(data, Key.enter)) {
						if (optionIndex === 0 && allAnswered()) {
							submit(false);
						} else if (optionIndex === 1) {
							submit(true);
						}
						return true;
					}
					return false;
				}

				const originalHandleInput = handleInput;
				const wrappedHandleInput = (data: string) => {
					if (isMulti && currentTab === questions.length) {
						if (!handleReviewInput(data)) {
							// Handle tab navigation and escape in review
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								currentTab = 0;
								optionIndex = 0;
								refresh();
								return;
							}
							if (
								matchesKey(data, Key.shift("tab")) ||
								matchesKey(data, Key.left)
							) {
								currentTab = questions.length - 1;
								optionIndex = 0;
								refresh();
								return;
							}
							if (matchesKey(data, Key.escape)) {
								submit(true);
							}
						}
					} else {
						originalHandleInput(data);
					}
				};

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput: wrappedHandleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				if (a.wasChat) {
					return `${a.questionLabel}: user said: "${a.label}"`;
				}
				if (a.wasCustom) {
					return `${a.questionLabel}: user wrote: "${a.label}"`;
				}
				return `${a.questionLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (qs.length > 0) {
				const labels = qs.map((q) => q.label || q.id).join(" → ");
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const prefix = theme.fg("success", "✓ ");
				const label = theme.fg("accent", a.questionLabel + ": ");
				if (a.wasChat) {
					return `${prefix}${label}${theme.fg("muted", "(chat) ")}${a.label}`;
				}
				if (a.wasCustom) {
					return `${prefix}${label}${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${prefix}${label}${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
