/**
 * Pi OpenTelemetry Monitoring Extension
 *
 * Exports telemetry data (metrics + events/logs) via OpenTelemetry so you can
 * track Pi usage in Datadog (or any OTEL-compatible backend) alongside your
 * team's Claude Code dashboards.
 *
 * All metrics and events live under the `pi.*` namespace — separate from
 * Claude Code's `claude_code.*` metrics. Combine them in Datadog with
 * formulas like `sum:pi.token.usage{*} + sum:claude_code.token.usage{*}`.
 *
 * Emitted metrics:
 *   - pi.session.count       — sessions started
 *   - pi.token.usage         — tokens by type (input/output/cacheRead/cacheCreation)
 *   - pi.cost.usage          — cost in USD per API request
 *   - pi.lines_of_code.count — lines added/removed by edit/write tools
 *   - pi.commit.count        — git commits created
 *   - pi.pull_request.count  — PRs created
 *   - pi.active_time.total   — active time in seconds
 *
 * Emitted events (via OTEL logs):
 *   - pi.user_prompt   — when user submits a prompt
 *   - pi.api_request   — after each LLM API response
 *   - pi.tool_result   — after each tool execution
 *
 * Configuration (environment variables — reuses Claude Code's OTEL vars):
 *   PI_ENABLE_TELEMETRY=1                — required to enable
 *   OTEL_METRICS_EXPORTER=otlp           — otlp | console
 *   OTEL_LOGS_EXPORTER=otlp              — otlp | console
 *   OTEL_EXPORTER_OTLP_PROTOCOL=...      — grpc | http/protobuf | http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=...      — collector endpoint
 *   OTEL_EXPORTER_OTLP_HEADERS=...       — auth headers (key=value,...)
 *   PI_OTEL_HEADERS_HELPER=...           — script that outputs headers as JSON (takes precedence)
 *   OTEL_EXPORTER_OTLP_METRICS_PROTOCOL  — per-signal override
 *   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  — per-signal override
 *   OTEL_EXPORTER_OTLP_LOGS_PROTOCOL     — per-signal override
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT     — per-signal override
 *   OTEL_METRIC_EXPORT_INTERVAL          — ms, default 60000
 *   OTEL_LOGS_EXPORT_INTERVAL            — ms, default 5000
 *   OTEL_RESOURCE_ATTRIBUTES             — e.g. env=local,team=platform
 *   OTEL_LOG_USER_PROMPTS=1              — log prompt content (default: off)
 *   OTEL_LOG_TOOL_DETAILS=1              — log tool names/params (default: off)
 *
 * Usage:
 *   1. cd this-dir && npm install
 *   2. Set env vars (or reuse your team's Claude Code managed settings):
 *        export PI_ENABLE_TELEMETRY=1
 *        export OTEL_METRICS_EXPORTER=otlp
 *        export OTEL_LOGS_EXPORTER=otlp
 *        export OTEL_EXPORTER_OTLP_HEADERS="dd-api-key=...,dd-otel-metric-config={\"resource_attributes_as_tags\": true}"
 *        export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://http-intake.logs.datadoghq.com/v1/logs
 *        export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
 *        export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp.datadoghq.com/v1/metrics
 *        export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf
 *        export OTEL_RESOURCE_ATTRIBUTES="env=local"
 *   3. Run pi (extension auto-discovered from extensions dir)
 */

import type { ExtensionAPI, ToolExecutionEndEvent } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { arch, hostname, platform, release, userInfo } from "node:os";

// ─── Env helpers ──────────────────────────────────────────────────────────────

const env = (key: string, fallback?: string): string | undefined => process.env[key] ?? fallback;
const envBool = (key: string): boolean => env(key) === "1" || env(key) === "true";
const envInt = (key: string, fallback: number): number => {
	const v = env(key);
	if (v === undefined) return fallback;
	const n = parseInt(v, 10);
	return isNaN(n) ? fallback : n;
};

// ─── Guard: bail out if telemetry not enabled ─────────────────────────────────

const ENABLED = envBool("PI_ENABLE_TELEMETRY");

export default function (pi: ExtensionAPI) {
	if (!ENABLED) {
		return;
	}

	// Lazy-init: import OTEL SDK only when telemetry is enabled so there's
	// zero overhead when it's off.
	let initialized = false;
	let sessionCounter: any;
	let tokenCounter: any;
	let costCounter: any;
	let linesOfCodeCounter: any;
	let commitCounter: any;
	let prCounter: any;
	let activeTimeCounter: any;
	let logger: any;
	let meterProvider: any;
	let loggerProvider: any;

	// Session-level state
	const sessionId = randomUUID();
	let eventSequence = 0;
	let currentPromptId: string | undefined;
	let lastActiveTimestamp = Date.now();
	let currentModel: string | undefined;

	// Cached SeverityNumber for log events
	let severityNumberInfo: number | undefined;

	// Standard attributes attached to every metric/event
	function getStandardAttributes(): Record<string, string> {
		const attrs: Record<string, string> = {
			"session.id": sessionId,
			"user.id": `pi-${userInfo().username}@${hostname()}`,
			"user.email": env("USER_EMAIL") ?? env("OTEL_USER_EMAIL") ?? `${userInfo().username}@${hostname()}`,
			"app.version": `pi-${VERSION ?? "unknown"}`,
			"terminal.type": env("TERM_PROGRAM") ?? env("TERM") ?? "unknown",
		};

		const ra = env("OTEL_RESOURCE_ATTRIBUTES");
		if (ra) {
			for (const pair of ra.split(",")) {
				const eqIdx = pair.indexOf("=");
				if (eqIdx > 0) {
					attrs[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
				}
			}
		}

		return attrs;
	}

	function parseOtlpHeaders(): Record<string, string> {
		// 1. Try headers helper script (like Claude Code's otelHeadersHelper)
		const helperScript = env("PI_OTEL_HEADERS_HELPER");
		if (helperScript) {
			try {
				const { execSync } = require("node:child_process");
				const output = execSync(helperScript, {
					timeout: 10_000,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				if (output) {
					return JSON.parse(output) as Record<string, string>;
				}
			} catch (error) {
				console.error("[otel-monitoring] Headers helper script failed:", error);
			}
		}

		// 2. Fall back to static env var
		const raw = env("OTEL_EXPORTER_OTLP_HEADERS");
		if (!raw) return {};
		const headers: Record<string, string> = {};
		for (const pair of raw.split(",")) {
			const eqIdx = pair.indexOf("=");
			if (eqIdx > 0) {
				headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
			}
		}
		return headers;
	}

	// ─── Initialize OTEL SDK lazily ──────────────────────────────────────────

	async function init() {
		if (initialized) return;
		initialized = true;

		try {
			const { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } = await import("@opentelemetry/sdk-metrics");
			const { Resource } = await import("@opentelemetry/resources");
			const { LoggerProvider, SimpleLogRecordProcessor, ConsoleLogRecordExporter, BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
			try {
				const apiLogs = await import("@opentelemetry/api-logs");
				severityNumberInfo = (apiLogs as any).SeverityNumber?.INFO ?? 9;
			} catch {
				severityNumberInfo = 9;
			}

			const standardAttrs = getStandardAttributes();
			const resource = new Resource({
				"service.name": "pi",
				"service.version": VERSION ?? "unknown",
				"host.arch": arch(),
				"os.type": platform(),
				"os.version": release(),
				...standardAttrs,
			});
			const headers = parseOtlpHeaders();

			// ─── Metrics setup ──────────────────────────────────────────

			const metricsExporterType = env("OTEL_METRICS_EXPORTER", "otlp");
			const metricsProtocol = env("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL") ?? env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
			const metricsEndpoint = env("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") ?? env("OTEL_EXPORTER_OTLP_ENDPOINT");
			const exportIntervalMs = envInt("OTEL_METRIC_EXPORT_INTERVAL", 60000);

			// AggregationTemporalityPreference: DELTA=0, CUMULATIVE=1, LOWMEMORY=2
			// Datadog requires DELTA for counters.
			const temporalityPrefStr = env("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta")?.toLowerCase();
			const temporalityPreference = temporalityPrefStr === "cumulative" ? 1 : temporalityPrefStr === "lowmemory" ? 2 : 0;

			let metricsExporter: any;

			if (metricsExporterType?.includes("console")) {
				metricsExporter = new ConsoleMetricExporter();
			} else if (metricsExporterType?.includes("otlp")) {
				if (metricsProtocol === "grpc") {
					const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
					metricsExporter = new OTLPMetricExporter({
						url: metricsEndpoint,
						headers,
						temporalityPreference,
					});
				} else {
					const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
					metricsExporter = new OTLPMetricExporter({
						url: metricsEndpoint,
						headers,
						temporalityPreference,
					});
				}
			}

			if (metricsExporter) {
				meterProvider = new MeterProvider({
					resource,
					readers: [
						new PeriodicExportingMetricReader({
							exporter: metricsExporter,
							exportIntervalMillis: exportIntervalMs,
						}),
					],
				});

				const meter = meterProvider.getMeter("pi-otel-monitoring");

				sessionCounter = meter.createCounter("pi.session.count", {
					description: "Count of Pi sessions started",
					unit: "count",
				});
				tokenCounter = meter.createCounter("pi.token.usage", {
					description: "Number of tokens used by Pi",
					unit: "tokens",
				});
				costCounter = meter.createCounter("pi.cost.usage", {
					description: "Cost of the Pi session",
					unit: "USD",
				});
				linesOfCodeCounter = meter.createCounter("pi.lines_of_code.count", {
					description: "Lines of code modified by Pi",
					unit: "count",
				});
				commitCounter = meter.createCounter("pi.commit.count", {
					description: "Git commits created via Pi",
					unit: "count",
				});
				prCounter = meter.createCounter("pi.pull_request.count", {
					description: "Pull requests created via Pi",
					unit: "count",
				});
				activeTimeCounter = meter.createCounter("pi.active_time.total", {
					description: "Total active time in Pi sessions",
					unit: "s",
				});
			}

			// ─── Logs/Events setup ──────────────────────────────────────

			const logsExporterType = env("OTEL_LOGS_EXPORTER");
			const logsProtocol = env("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL") ?? env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
			const logsEndpoint = env("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ?? env("OTEL_EXPORTER_OTLP_ENDPOINT");
			const logsExportInterval = envInt("OTEL_LOGS_EXPORT_INTERVAL", 5000);

			let logsExporter: any;

			if (logsExporterType?.includes("console")) {
				logsExporter = new ConsoleLogRecordExporter();
			} else if (logsExporterType?.includes("otlp")) {
				if (logsProtocol === "grpc") {
					const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
					logsExporter = new OTLPLogExporter({ url: logsEndpoint, headers });
				} else {
					const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto");
					logsExporter = new OTLPLogExporter({ url: logsEndpoint, headers });
				}
			}

			if (logsExporter) {
				loggerProvider = new LoggerProvider({ resource });

				if (logsExporterType?.includes("console")) {
					loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logsExporter));
				} else {
					loggerProvider.addLogRecordProcessor(
						new BatchLogRecordProcessor(logsExporter, { scheduledDelayMillis: logsExportInterval })
					);
				}

				logger = loggerProvider.getLogger("pi-otel-monitoring");
			}
		} catch (error) {
			console.error("[otel-monitoring] Failed to initialize OTEL SDK:", error);
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	function emitEvent(eventName: string, attrs: Record<string, string | number | boolean>) {
		if (!logger) return;

		const allAttrs: Record<string, string | number | boolean> = {
			...getStandardAttributes(),
			"event.name": eventName,
			"event.timestamp": new Date().toISOString(),
			"event.sequence": ++eventSequence,
			...attrs,
		};

		if (currentPromptId) {
			allAttrs["prompt.id"] = currentPromptId;
		}

		logger.emit({
			severityNumber: severityNumberInfo ?? 9,
			severityText: "Info",
			body: eventName,
			attributes: allAttrs,
		});
	}

	function trackActiveTime(type: "user" | "cli") {
		if (!activeTimeCounter) return;
		const now = Date.now();
		const elapsed = (now - lastActiveTimestamp) / 1000;
		if (elapsed > 0 && elapsed < 300) {
			activeTimeCounter.add(elapsed, { ...getStandardAttributes(), type });
		}
		lastActiveTimestamp = now;
	}

	const toolTimings = new Map<string, number>();
	const toolArgs = new Map<string, any>();

	// ─── Event handlers ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await init();

		if (sessionCounter) {
			sessionCounter.add(1, getStandardAttributes());
		}

		ctx.ui.setStatus("otel", "OTEL \u2713");
	});

	pi.on("input", async (event) => {
		currentPromptId = randomUUID();
		lastActiveTimestamp = Date.now();

		const attrs: Record<string, string | number | boolean> = {
			prompt_length: typeof event.text === "string" ? event.text.length : 0,
		};

		if (envBool("OTEL_LOG_USER_PROMPTS") && typeof event.text === "string") {
			attrs["prompt"] = event.text;
		} else {
			attrs["prompt"] = "[redacted]";
		}

		emitEvent("pi.user_prompt", attrs);

		return { action: "continue" as const };
	});

	pi.on("model_select", async (event) => {
		currentModel = event.model.id;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (!msg || (msg as any).role !== "assistant") return;

		const assistantMsg = msg as any;
		const usage = assistantMsg.usage;
		if (!usage) return;

		const model = assistantMsg.model ?? currentModel ?? "unknown";
		const stdAttrs = getStandardAttributes();

		if (tokenCounter) {
			if (usage.input > 0) {
				tokenCounter.add(usage.input, { ...stdAttrs, type: "input", model });
			}
			if (usage.output > 0) {
				tokenCounter.add(usage.output, { ...stdAttrs, type: "output", model });
			}
			if (usage.cacheRead > 0) {
				tokenCounter.add(usage.cacheRead, { ...stdAttrs, type: "cacheRead", model });
			}
			if (usage.cacheWrite > 0) {
				tokenCounter.add(usage.cacheWrite, { ...stdAttrs, type: "cacheCreation", model });
			}
		}

		if (costCounter && usage.cost?.total > 0) {
			costCounter.add(usage.cost.total, { ...stdAttrs, model });
		}

		trackActiveTime("cli");

		emitEvent("pi.api_request", {
			model,
			cost_usd: usage.cost?.total ?? 0,
			input_tokens: usage.input ?? 0,
			output_tokens: usage.output ?? 0,
			cache_read_tokens: usage.cacheRead ?? 0,
			cache_creation_tokens: usage.cacheWrite ?? 0,
		});
	});

	pi.on("tool_execution_start", async (event) => {
		toolTimings.set(event.toolCallId, Date.now());
		toolArgs.set(event.toolCallId, event.args);
	});

	pi.on("tool_execution_end", async (event: ToolExecutionEndEvent) => {
		const startTime = toolTimings.get(event.toolCallId);
		const args = toolArgs.get(event.toolCallId);
		toolTimings.delete(event.toolCallId);
		toolArgs.delete(event.toolCallId);
		const durationMs = startTime ? Date.now() - startTime : 0;

		trackActiveTime("cli");

		if (event.toolName === "bash" || event.toolName === "Bash") {
			const command: string = args?.command ?? "";

			if (command.includes("git commit") && !event.isError) {
				commitCounter?.add(1, getStandardAttributes());
			}
			if (command.includes("gh pr create") && !event.isError) {
				prCounter?.add(1, getStandardAttributes());
			}
		}

		if (event.toolName === "edit" || event.toolName === "Edit") {
			const result = event.result;
			if (result && typeof result === "object" && result.details?.diff) {
				const diff: string = result.details.diff;
				let added = 0;
				let removed = 0;
				for (const line of diff.split("\n")) {
					if (line.startsWith("+") && !line.startsWith("+++")) added++;
					else if (line.startsWith("-") && !line.startsWith("---")) removed++;
				}
				if (added > 0) {
					linesOfCodeCounter?.add(added, { ...getStandardAttributes(), type: "added" });
				}
				if (removed > 0) {
					linesOfCodeCounter?.add(removed, { ...getStandardAttributes(), type: "removed" });
				}
			}
		}

		if (event.toolName === "write" || event.toolName === "Write") {
			const newText: string = args?.content ?? "";
			if (newText) {
				const lineCount = newText.split("\n").length;
				if (lineCount > 0) {
					linesOfCodeCounter?.add(lineCount, { ...getStandardAttributes(), type: "added" });
				}
			}
		}

		const toolAttrs: Record<string, string | number | boolean> = {
			tool_name: event.toolName,
			success: event.isError ? "false" : "true",
			duration_ms: durationMs,
		};

		if (event.isError && event.result) {
			const errText = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			toolAttrs["error"] = errText.slice(0, 500);
		}

		if (envBool("OTEL_LOG_TOOL_DETAILS")) {
			toolAttrs["tool_parameters"] = JSON.stringify(event.result?.details ?? {}).slice(0, 1000);
		}

		emitEvent("pi.tool_result", toolAttrs);
	});

	pi.on("turn_end", async () => {
		trackActiveTime("cli");
	});

	pi.on("agent_end", async () => {
		trackActiveTime("user");
	});

	pi.on("session_shutdown", async () => {
		try {
			if (meterProvider) {
				await meterProvider.forceFlush();
			}
			if (loggerProvider) {
				await loggerProvider.forceFlush();
			}
		} catch (error) {
			console.error("[otel-monitoring] Error flushing telemetry on shutdown:", error);
		}
	});
}
