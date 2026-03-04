/**
 * Multi-Profile Extension
 *
 * Registers multiple providers per profile so you can store separate
 * credentials for different accounts and switch via /model.
 *
 * Supported providers: anthropic, openai, google, xai, groq, openrouter,
 * mistral, and any other provider with built-in streaming support.
 * Anthropic profiles include OAuth support for Claude Pro/Max subscriptions.
 *
 * Usage:
 *   1. Install dependencies: cd this-dir && npm install
 *   2. Run pi with the extension:
 *        pi -e ./path/to/multi-profile
 *      Or symlink/copy into ~/.pi/agent/extensions/multi-profile/
 *   3. Add profiles:
 *        /profile add work
 *   4. Authenticate each:
 *        /login anthropic:work      (OAuth for Anthropic)
 *        /login openai-codex:work   (OAuth for ChatGPT Plus/Pro)
 *        Set OPENAI_WORK_API_KEY    (env var for OpenAI API keys)
 *   5. Switch via /model — pick from anthropic:work/*, openai-codex:work/*, etc.
 *
 * Profiles are stored in profiles.json next to this file.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	calculateCost,
	createAssistantMessageEventStream,
	getModels,
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Config
// =============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = join(__dirname, "profiles.json");

interface ProfileConfig {
	name: string;
	providers: string[];
}

interface ProviderInfo {
	api: Api;
	baseUrl: string;
	envKey: string;
	hasOAuth?: boolean;
}

const SUPPORTED_PROVIDERS: Record<string, ProviderInfo> = {
	anthropic: { api: "anthropic-messages" as Api, baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC", hasOAuth: true },
	"openai-codex": { api: "openai-codex-responses" as Api, baseUrl: "https://chatgpt.com/backend-api", envKey: "OPENAI_CODEX", hasOAuth: true },
	openai: { api: "openai-responses" as Api, baseUrl: "https://api.openai.com/v1", envKey: "OPENAI" },
	google: { api: "google-generative-ai" as Api, baseUrl: "https://generativelanguage.googleapis.com/v1beta", envKey: "GEMINI" },
	xai: { api: "openai-completions" as Api, baseUrl: "https://api.x.ai/v1", envKey: "XAI" },
	groq: { api: "openai-completions" as Api, baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ" },
	openrouter: { api: "openai-completions" as Api, baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER" },
	mistral: { api: "openai-completions" as Api, baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL" },
	cerebras: { api: "openai-completions" as Api, baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS" },
};

function loadProfiles(): ProfileConfig[] {
	if (!existsSync(PROFILES_PATH)) return [];
	try {
		const data = JSON.parse(readFileSync(PROFILES_PATH, "utf-8"));
		if (!Array.isArray(data)) return [];
		// Support old format (string[]) and new format (ProfileConfig[])
		return data.map((entry: string | ProfileConfig) => {
			if (typeof entry === "string") {
				return { name: entry, providers: Object.keys(SUPPORTED_PROVIDERS) };
			}
			return entry;
		});
	} catch {}
	return [];
}

function saveProfiles(profiles: ProfileConfig[]): void {
	writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2) + "\n");
}

// =============================================================================
// Model mapping
// =============================================================================

function getProviderModels(provider: string, profileName: string): ProviderModelConfig[] {
	const builtIn = getModels(provider as any);
	return builtIn.map((m) => ({
		id: m.id,
		name: `${m.name} (${profileName})`,
		reasoning: m.reasoning,
		input: m.input,
		cost: { ...m.cost },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: m.compat,
	}));
}

// =============================================================================
// Anthropic OAuth (same flow as built-in)
// =============================================================================

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});
	callbacks.onAuth({ url: `${AUTHORIZE_URL}?${authParams.toString()}` });
	const authCode = await callbacks.onPrompt({ message: "Paste the authorization code:" });
	const [code, state] = authCode.split("#");
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});
	if (!resp.ok) throw new Error(`Token exchange failed: ${await resp.text()}`);
	const data = (await resp.json()) as { access_token: string; refresh_token: string; expires_in: number };
	return { refresh: data.refresh_token, access: data.access_token, expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000 };
}

async function refreshAnthropicToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credentials.refresh }),
	});
	if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
	const data = (await resp.json()) as { access_token: string; refresh_token: string; expires_in: number };
	return { refresh: data.refresh_token, access: data.access_token, expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000 };
}

// =============================================================================
// Anthropic streaming (required for OAuth stealth mode)
// =============================================================================

const claudeCodeTools = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "AskUserQuestion", "TodoWrite", "WebFetch", "WebSearch"];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	const lower = name.toLowerCase();
	return tools?.find((t) => t.name.toLowerCase() === lower)?.name ?? name;
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function sanitize(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(content: (TextContent | ImageContent)[]): string | Array<{ type: "text"; text: string } | { type: "image"; source: any }> {
	if (!content.some((c) => c.type === "image")) {
		return sanitize(content.map((c) => (c as TextContent).text).join("\n"));
	}
	const blocks = content.map((b) =>
		b.type === "text" ? { type: "text" as const, text: sanitize(b.text) } : { type: "image" as const, source: { type: "base64" as const, media_type: b.mimeType, data: b.data } },
	);
	if (!blocks.some((b) => b.type === "text")) blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	return blocks;
}

function convertMessages(messages: Message[], isOAuth: boolean, tools?: Tool[]): any[] {
	const params: any[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) params.push({ role: "user", content: sanitize(msg.content) });
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitize(item.text) }
						: { type: "image" as const, source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data } },
				);
				if (blocks.length > 0) params.push({ role: "user", content: blocks });
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitize(block.text) });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					if ((block as ThinkingContent).thinkingSignature) {
						blocks.push({ type: "thinking" as any, thinking: sanitize(block.thinking), signature: (block as ThinkingContent).thinkingSignature! });
					} else {
						blocks.push({ type: "text", text: sanitize(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					blocks.push({ type: "tool_use", id: block.id, name: isOAuth ? toClaudeCodeName(block.name) : block.name, input: block.arguments });
				}
			}
			if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const toolResults: any[] = [];
			toolResults.push({ type: "tool_result", tool_use_id: msg.toolCallId, content: convertContentBlocks(msg.content), is_error: msg.isError });
			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const next = messages[j] as ToolResultMessage;
				toolResults.push({ type: "tool_result", tool_use_id: next.toolCallId, content: convertContentBlocks(next.content), is_error: next.isError });
				j++;
			}
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
		}
	}
	return params;
}

function convertTools(tools: Tool[], isOAuth: boolean): any[] {
	return tools.map((tool) => ({
		name: isOAuth ? toClaudeCodeName(tool.name) : tool.name,
		description: tool.description,
		input_schema: { type: "object", properties: (tool.parameters as any).properties || {}, required: (tool.parameters as any).required || [] },
	}));
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

function streamAnthropic(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			const apiKey = options?.apiKey ?? "";
			const isOAuth = isOAuthToken(apiKey);
			const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
			const clientOptions: any = { baseURL: model.baseUrl, dangerouslyAllowBrowser: true };
			if (isOAuth) {
				clientOptions.apiKey = null;
				clientOptions.authToken = apiKey;
				clientOptions.defaultHeaders = {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
					"user-agent": "claude-cli/2.1.2 (external, cli)",
					"x-app": "cli",
				};
			} else {
				clientOptions.apiKey = apiKey;
				clientOptions.defaultHeaders = { accept: "application/json", "anthropic-dangerous-direct-browser-access": "true", "anthropic-beta": betaFeatures.join(",") };
			}
			const client = new Anthropic(clientOptions);
			const params: MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertMessages(context.messages, isOAuth, context.tools),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};
			if (isOAuth) {
				params.system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }];
				if (context.systemPrompt) params.system.push({ type: "text", text: sanitize(context.systemPrompt), cache_control: { type: "ephemeral" } });
			} else if (context.systemPrompt) {
				params.system = [{ type: "text", text: sanitize(context.systemPrompt), cache_control: { type: "ephemeral" } }];
			}
			if (context.tools) params.tools = convertTools(context.tools, isOAuth);
			const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 20480 };
			if (options?.reasoning && options.reasoning !== "off" && model.reasoning) {
				const custom = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
				const budgetTokens = custom ?? budgets[options.reasoning] ?? 10240;
				// Anthropic requires max_tokens > thinking.budget_tokens
				if (params.max_tokens > budgetTokens) {
					params.thinking = { type: "enabled", budget_tokens: budgetTokens };
				} else {
					params.thinking = { type: "enabled", budget_tokens: Math.max(1024, params.max_tokens - 1) };
				}
			}
			const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index } as any);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth ? fromClaudeCodeName(event.content_block.name, context.tools) : event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const idx = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[idx];
					if (!block) continue;
					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: idx, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.delta.thinking, partial: output });
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson += event.delta.partial_json;
						try { block.arguments = JSON.parse((block as any).partialJson); } catch {}
						stream.push({ type: "toolcall_delta", contentIndex: idx, delta: event.delta.partial_json, partial: output });
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					const idx = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[idx];
					if (!block) continue;
					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try { block.arguments = JSON.parse((block as any).partialJson); } catch {}
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if ((event.delta as any).stop_reason) output.stopReason = mapStopReason((event.delta as any).stop_reason);
					output.usage.input = (event.usage as any).input_tokens || 0;
					output.usage.output = (event.usage as any).output_tokens || 0;
					output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

// =============================================================================
// Provider registration
// =============================================================================

function registerProviderProfile(pi: ExtensionAPI, provider: string, profileName: string): void {
	const providerName = `${provider}:${profileName}`;
	const info = SUPPORTED_PROVIDERS[provider];
	if (!info) return;

	const models = getProviderModels(provider, profileName);
	if (models.length === 0) return;

	const envKey = `${info.envKey}_${profileName.toUpperCase()}_API_KEY`;

	const config: ProviderConfig = {
		baseUrl: info.baseUrl,
		apiKey: envKey,
		api: info.api,
		models,
	};

	// Anthropic needs custom streaming for OAuth stealth mode
	if (provider === "anthropic") {
		config.streamSimple = streamAnthropic;
		config.oauth = {
			name: `Anthropic (${profileName})`,
			login: loginAnthropic,
			refreshToken: refreshAnthropicToken,
			getApiKey: (cred) => cred.access,
		};
	}

	// OpenAI Codex uses built-in streaming but needs OAuth for ChatGPT subscription
	if (provider === "openai-codex") {
		config.oauth = {
			name: `ChatGPT Plus/Pro (${profileName})`,
			login: (callbacks) =>
				loginOpenAICodex({
					onAuth: callbacks.onAuth,
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
					onManualCodeInput: callbacks.onManualCodeInput,
				}),
			refreshToken: (cred) => refreshOpenAICodexToken(cred.refresh),
			getApiKey: (cred) => cred.access,
		};
	}

	pi.registerProvider(providerName, config);
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	const profiles = loadProfiles();
	for (const profile of profiles) {
		for (const provider of profile.providers) {
			registerProviderProfile(pi, provider, profile.name);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (profiles.length > 0) {
			const summary = profiles.map((p) => `${p.name} (${p.providers.join(", ")})`).join("; ");
			ctx.ui.notify(`Multi-profile: ${summary}`, "info");
		}
	});

	pi.registerCommand("profile", {
		description: "Manage credential profiles (add/remove/list)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["add", "remove", "list"];
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const filtered = subcommands.filter((s) => s.startsWith(parts[0] ?? ""));
				return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
			}
			if (parts[0] === "remove" && parts.length === 2) {
				const current = loadProfiles();
				const filtered = current.filter((p) => p.name.startsWith(parts[1] ?? ""));
				return filtered.length > 0 ? filtered.map((p) => ({ value: `remove ${p.name}`, label: p.name })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			if (subcommand === "list" || !subcommand) {
				const current = loadProfiles();
				if (current.length === 0) {
					ctx.ui.notify("No profiles configured. Use /profile add <name>", "info");
				} else {
					for (const p of current) {
						ctx.ui.notify(`${p.name}: ${p.providers.join(", ")}`, "info");
					}
				}
				return;
			}

			if (subcommand === "add") {
				let name = parts[1];
				if (!name) {
					name = (await ctx.ui.input("Profile name:", "e.g. work, personal")) ?? "";
				}
				name = name.trim();
				if (!name) return;
				if (name.includes(":")) {
					ctx.ui.notify("Profile name cannot contain colons", "error");
					return;
				}
				const current = loadProfiles();
				if (current.find((p) => p.name === name)) {
					ctx.ui.notify(`Profile "${name}" already exists`, "warning");
					return;
				}

				// Let user pick which providers to include
				const providerNames = Object.keys(SUPPORTED_PROVIDERS);
				const selectedProviders: string[] = [];
				const choice = await ctx.ui.select(
					`Select providers for "${name}" profile:`,
					["All providers", ...providerNames],
				);
				if (!choice) return;
				if (choice === "All providers") {
					selectedProviders.push(...providerNames);
				} else {
					selectedProviders.push(choice);
					// Ask if they want more
					let addMore = true;
					while (addMore) {
						const remaining = providerNames.filter((p) => !selectedProviders.includes(p));
						if (remaining.length === 0) break;
						const more = await ctx.ui.select(
							`Add another provider? (selected: ${selectedProviders.join(", ")})`,
							["Done", ...remaining],
						);
						if (!more || more === "Done") {
							addMore = false;
						} else {
							selectedProviders.push(more);
						}
					}
				}

				current.push({ name, providers: selectedProviders });
				saveProfiles(current);
				ctx.ui.notify(`Profile "${name}" added with: ${selectedProviders.join(", ")}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			if (subcommand === "remove") {
				let name = parts[1];
				const current = loadProfiles();
				if (!name) {
					if (current.length === 0) {
						ctx.ui.notify("No profiles to remove", "info");
						return;
					}
					name = (await ctx.ui.select("Remove which profile?", current.map((p) => p.name))) ?? "";
				}
				name = name.trim();
				if (!name) return;
				const idx = current.findIndex((p) => p.name === name);
				if (idx === -1) {
					ctx.ui.notify(`Profile "${name}" not found`, "error");
					return;
				}
				current.splice(idx, 1);
				saveProfiles(current);
				ctx.ui.notify(`Profile "${name}" removed. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			ctx.ui.notify("Usage: /profile add|remove|list [name]", "info");
		},
	});
}
