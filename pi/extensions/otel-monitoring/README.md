# Pi OTEL Monitoring Extension

OpenTelemetry monitoring for Pi. Tracks token usage, costs, sessions, and tool activity under the `pi.*` namespace — keeping it cleanly separated from Claude Code's `claude_code.*` metrics while using the same OTEL infrastructure and Datadog instance.

## Why?

If your team uses Claude Code with OTEL monitoring (see [Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage)), you already have the OTEL → Datadog pipeline set up. This extension reuses that same pipeline but emits metrics under `pi.*` so the two sources don't get mixed.

To see combined totals in Datadog, use formulas:
```
sum:pi.token.usage{*} + sum:claude_code.token.usage{*}
```

Or create side-by-side widgets filtering by `pi.*` vs `claude_code.*`.

## Setup

### 1. Install dependencies

```bash
cd ~/workspace/psg2/agent-stuff/pi/extensions/otel-monitoring
npm install
```

### 2. Configure environment variables

The extension reads the **same env vars** as Claude Code's OTEL support. If you already have them set, Pi will pick them up automatically.

#### Datadog (matching the team's existing config)

```bash
export PI_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_HEADERS="dd-api-key=YOUR_DD_API_KEY,dd-otel-metric-config={\"resource_attributes_as_tags\": true}"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="https://http-intake.logs.datadoghq.com/v1/logs"
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="https://otlp.datadoghq.com/v1/metrics"
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL="http/protobuf"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_RESOURCE_ATTRIBUTES="env=local"
```

#### Console debugging

```bash
export PI_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=console
export OTEL_LOGS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=5000
```

### 3. Run Pi

The extension is auto-discovered from the extensions directory. You'll see `OTEL ✓` in the footer when telemetry is active.

## Metrics

| Metric | Description | Extra Attributes |
|--------|-------------|------------------|
| `pi.session.count` | Sessions started | — |
| `pi.token.usage` | Tokens by type | `type` (input/output/cacheRead/cacheCreation), `model` |
| `pi.cost.usage` | Cost in USD | `model` |
| `pi.lines_of_code.count` | Lines modified | `type` (added/removed) |
| `pi.commit.count` | Git commits | — |
| `pi.pull_request.count` | PRs created | — |
| `pi.active_time.total` | Active time (seconds) | `type` (user/cli) |

## Events (Logs)

| Event | Description | Key Attributes |
|-------|-------------|----------------|
| `pi.user_prompt` | User submits prompt | `prompt_length`, `prompt` (if `OTEL_LOG_USER_PROMPTS=1`) |
| `pi.api_request` | LLM API response | `model`, `cost_usd`, `input_tokens`, `output_tokens`, cache tokens |
| `pi.tool_result` | Tool execution completes | `tool_name`, `success`, `duration_ms` |

All events include a `prompt.id` UUID for correlating activity within a single user prompt.

## Standard Attributes

Every metric and event includes:

| Attribute | Description |
|-----------|-------------|
| `session.id` | Unique session UUID |
| `user.id` | `pi-{username}@{hostname}` |
| `user.email` | From `USER_EMAIL` / `OTEL_USER_EMAIL` env, or `{username}@{hostname}` |
| `app.version` | `pi-{version}` |
| `terminal.type` | From `TERM_PROGRAM` |

Plus any custom attributes from `OTEL_RESOURCE_ATTRIBUTES`.

## Privacy

- **User prompts are NOT logged by default.** Set `OTEL_LOG_USER_PROMPTS=1` to enable.
- **Tool details are NOT logged by default.** Set `OTEL_LOG_TOOL_DETAILS=1` to enable.
- No telemetry is sent unless `PI_ENABLE_TELEMETRY=1` is set.
