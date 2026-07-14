---
{ "kind": "tooling", "version": 3, "website": "https://sentry.io" }
---

# Add Sentry to Flue

You are an AI coding agent adding Sentry observability to a Flue project:
errors as issues, `ctx.log.*` as Sentry Logs, and — when tracing is enabled —
the full workflow → agent → model → tool span hierarchy with token usage and
cost, following the OpenTelemetry GenAI conventions. A run's spans, logs, and
issues share one trace.

Issues come only from terminal failures: a failed workflow run, a failed
top-level agent operation, and a failed durable submission. Recovered nested
tool and model failures stay on their span and are not raised as issues, and
logs are never promoted to issues. Content capture (prompts, model output, tool
values) is off by default.

## Inspect the project

Read local instructions, detect the package manager, and select the first
existing source root: `<root>/.flue/`, then `<root>/src/`, then `<root>/`. Inspect
`flue.config.ts`, deployment commands, `app.ts`, every module under `agents/` and
`workflows/`, environment types, and secret conventions.

Install `@flue/opentelemetry` and `@opentelemetry/api@^1.9.0`, then the SDK for
the configured target:

- **Node:** install `@sentry/node@^10.64.0`.
- **Cloudflare:** install `@sentry/cloudflare@^10.64.0`. Do not use `@sentry/node`
  through `nodejs_compat`.

If the target cannot be determined, ask the user. Do not install both SDKs to
make one static source file target-agnostic.

## Configure Sentry

Use these environment variables unless the project already has an established
Sentry convention:

| Variable                    | Purpose                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | Project DSN; keep it configurable through the deployment environment.                                 |
| `SENTRY_ENVIRONMENT`        | Optional environment name such as `production` or `staging`.                                          |
| `SENTRY_RELEASE`            | Optional release identifier such as a commit SHA.                                                     |
| `SENTRY_TRACES_SAMPLE_RATE` | Tracing sample rate, default `0`. `> 0` enables the gen_ai span hierarchy; `0` is errors + logs only. |
| `SENTRY_AI_RECORD_INPUTS`   | Set to `true` to export prompts, system instructions, and tool arguments.                             |
| `SENTRY_AI_RECORD_OUTPUTS`  | Set to `true` to export model output and tool results.                                                |

Never invent a DSN or hard-code it in application source. A Sentry DSN permits
event submission but does not grant read access to project data. Update an
existing `.env.example`, environment type, or deployment documentation when the
project maintains one, and preserve its deployment-configuration conventions.

## Decide what may leave the application

Tracing content — prompts, system instructions, tool definitions, tool
arguments, model output, and tool results — is exported only when
`SENTRY_AI_RECORD_INPUTS` / `SENTRY_AI_RECORD_OUTPUTS` are `true`, through the
content transform below. Review the application's retention, access, privacy,
and compliance requirements before enabling either, and implement
application-specific redaction in `scrub(...)` rather than relying on a generic
secret-shaped-key list.

## Create the Flue integration

Create `<source-dir>/sentry.ts`. `traceLifecycle: 'stream'` sends each span as
it finishes, so gen_ai spans that complete after their parent are not lost; keep
it for both targets.

### Node

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@3

import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { type FlueEvent, instrument, observe } from '@flue/runtime';
import * as Sentry from '@sentry/node';

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  'Anthropic_AI',
  'OpenAI',
  'Google_GenAI',
  'LangChain',
  'LangGraph',
  'VercelAI',
]);

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  attachStacktrace: true,
  tracesSampleRate,
  traceLifecycle: 'stream',
  streamGenAiSpans: true,
  enableLogs: true,
  integrations: (defaults) =>
    defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
});

if (tracesSampleRate > 0) {
  instrument(
    createOpenTelemetryInstrumentation({
      content: {
        enabled: recordInputs || recordOutputs,
        transform(content, scope) {
          if (isInputContent(scope.contentType) && !recordInputs) return undefined;
          if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
          return scrub(content);
        },
        limits: { maxAttributeBytes: 16_384, maxMessageParts: 32, maxToolDefinitions: 32 },
      },
    }),
  );
}
```

### Cloudflare

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@3

import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { type FlueEvent, instrument, observe } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';
import * as Sentry from '@sentry/cloudflare';

interface Env {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';

const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  'Anthropic_AI',
  'OpenAI',
  'Google_GenAI',
  'LangChain',
  'LangGraph',
  'VercelAI',
]);

export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      (env: Env) => ({
        dsn: env.SENTRY_DSN,
        enabled: Boolean(env.SENTRY_DSN),
        environment: env.SENTRY_ENVIRONMENT,
        release: env.SENTRY_RELEASE,
        attachStacktrace: true,
        tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? '0') || 0,
        traceLifecycle: 'stream',
        streamGenAiSpans: true,
        enableLogs: true,
        integrations: (defaults) =>
          defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
      }),
      Final,
    ),
});

if (Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0') > 0) {
  instrument(
    createOpenTelemetryInstrumentation({
      content: {
        enabled: recordInputs || recordOutputs,
        transform(content, scope) {
          if (isInputContent(scope.contentType) && !recordInputs) return undefined;
          if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
          return scrub(content);
        },
        limits: { maxAttributeBytes: 16_384, maxMessageParts: 32, maxToolDefinitions: 32 },
      },
    }),
  );
}
```

On Cloudflare, do not call `Sentry.init()` in this file: the Durable Object
wrapper initializes the SDK per isolate. `Sentry.logger` and
`Sentry.captureException` below resolve against the isolate's own client. On
Node, `Sentry.logger.*` uses the module-scoped client.

### Shared bridge

Append this to `sentry.ts` after the target-specific code above:

```ts
const runTags = new Map<string, Record<string, string>>();

observe((event) => {
  if (event.type === 'run_start' || event.type === 'run_resume') {
    runTags.set(event.runId, { 'flue.workflow': event.workflowName });
    return;
  }

  const tags = correlationTags(event);

  if (event.type === 'run_end') {
    runTags.delete(event.runId);
    if (event.isError) captureIncident(event.error, tags, { durationMs: event.durationMs });
    return;
  }
  if (event.type === 'operation' && event.isError && !event.runId) {
    captureIncident(event.error, tags, {
      durationMs: event.durationMs,
      operationKind: event.operationKind,
    });
    return;
  }
  if (event.type === 'submission_settled' && event.outcome === 'failed') {
    captureIncident(event.error, tags);
    return;
  }
  if (event.type === 'log') {
    const attributes = logAttributes(event);
    if (event.level === 'info') Sentry.logger.info(event.message, attributes);
    else if (event.level === 'warn') Sentry.logger.warn(event.message, attributes);
    else Sentry.logger.error(event.message, attributes);
  }
});

function captureIncident(
  error: unknown,
  tags: Record<string, string>,
  context?: Record<string, unknown>,
): void {
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    scope.setLevel('error');
    if (context) scope.setContext('flue.incident', context);
    Sentry.captureException(toError(error));
  });
}

function correlationTags(event: FlueEvent): Record<string, string> {
  const tags: Record<string, string> = event.runId ? { ...runTags.get(event.runId) } : {};
  if (event.runId) tags['flue.run.id'] = event.runId;
  if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
  if (event.agentName) tags['flue.agent.name'] = event.agentName;
  if (event.dispatchId) tags['flue.dispatch.id'] = event.dispatchId;
  if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
  if (event.conversationId) tags['flue.conversation.id'] = event.conversationId;
  if (event.harness) tags['flue.harness'] = event.harness;
  if (event.session) tags['flue.session'] = event.session;
  if (event.operationId) tags['flue.operation.id'] = event.operationId;
  if (event.taskId) tags['flue.task.id'] = event.taskId;
  return tags;
}

type LogAttribute = string | number | boolean;

function logAttributes(event: Extract<FlueEvent, { type: 'log' }>): Record<string, LogAttribute> {
  const attributes: Record<string, LogAttribute> = {};
  for (const [key, value] of Object.entries(correlationTags(event))) attributes[key] = value;
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    const scrubbed = scrub(value);
    attributes[`flue.log.${key}`] =
      typeof scrubbed === 'string' || typeof scrubbed === 'number' || typeof scrubbed === 'boolean'
        ? scrubbed
        : stringify(scrubbed);
  }
  return attributes;
}

function isInputContent(contentType: string): boolean {
  return (
    contentType === 'input_messages' ||
    contentType === 'system_instructions' ||
    contentType === 'tool_definitions' ||
    contentType === 'tool_description' ||
    contentType === 'tool_arguments'
  );
}

function isOutputContent(contentType: string): boolean {
  return (
    contentType === 'output_messages' ||
    contentType === 'tool_result' ||
    contentType === 'exception_message'
  );
}

const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;

function scrub(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, seen, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(nested, seen, depth + 1),
    ]),
  );
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const source = value as { name?: unknown; message?: unknown; stack?: unknown };
    const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
    if (typeof source.name === 'string') error.name = source.name;
    if (typeof source.stack === 'string') error.stack = source.stack;
    return error;
  }
  return new Error(typeof value === 'string' ? value : stringify(value));
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clampRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
```

On Node, flush buffered events (notably Sentry Logs, which the SDK batches) on
shutdown. Do not call `process.exit()` here — Flue's generated server already
handles `SIGINT` / `SIGTERM`, awaits its lifecycle stop, and exits with the
correct code; this handler only flushes within that window and must not race or
override it.

```ts
if (process.env.SENTRY_DSN) {
  const flush = () => void Sentry.flush(2000);
  process.once('SIGINT', flush);
  process.once('SIGTERM', flush);
}
```

Import the bridge once from the source-root `app.ts`:

```ts title="src/app.ts"
import './sentry.ts';
```

Preserve the application's existing imports, middleware, routes, and default
export. If there is no `app.ts`, create one that imports `./sentry.ts`, creates a
Hono application, mounts `flue()` at `/`, and default-exports the app. Install a
direct `hono` dependency when authoring that file.

## Wire Cloudflare Durable Objects

Skip this section for Node.

Flue runs each agent and workflow in its own Durable Object isolate, so the
`observe(...)` and `instrument(...)` registrations in `sentry.ts` must run inside
each isolate. Re-export the `cloudflare` extension from every discovered
`agents/<name>.ts` and `workflows/<name>.ts` module — the re-export evaluates
`sentry.ts` in that isolate and applies the Sentry Durable Object wrapper to the
generated class:

```ts
export { cloudflare } from '../sentry.ts';
```

Preserve each module's existing default agent or workflow definition and its
`route` / `runs` exports. Flue applies `wrap` after constructing its final
generated Durable Object class and types it as the branded Durable Object
constructor Sentry requires, so the pass-through needs no generics or casts. Do
not replace Flue-owned lifecycle methods or return a subclass.

Configure `SENTRY_DSN` through a Worker secret or environment binding, and keep
it outside application source. Flue already requires the `nodejs_compat`
compatibility flag; preserve it. This wrapper covers generated agent and workflow
Durable Objects, not the outer Worker or `FlueRegistry`; add `@sentry/cloudflare`
Hono middleware separately if you want HTTP request instrumentation on an
authored `app.ts`.

## Verify

1. Type-check the project and build its configured Flue target.
2. Start the real target runtime with a non-production Sentry project and
   `SENTRY_TRACES_SAMPLE_RATE=1`.
3. Run a workflow that calls an agent with a tool; confirm one trace with the
   `invoke_workflow` → `invoke_agent` → `chat` → `execute_tool` span hierarchy,
   token usage and cost on the model spans, and its `ctx.log.*` entries in
   Sentry Logs on the same trace.
4. Trigger a workflow whose run fails; confirm exactly one issue from `run_end`
   with `flue.run.id` and `flue.workflow` tags, on the run's trace.
5. Trigger a failed direct or dispatched agent operation and confirm one issue
   with no `flue.run.id`; reconcile a durable submission as failed and confirm
   one settlement issue.
6. Log an error with `ctx.log.error(...)` from a handler that recovers; confirm
   it appears in Sentry Logs and does not create an issue.
7. On Cloudflare, exercise a wrapped agent or workflow Durable Object under
   workerd and confirm its trace, logs, and any issue are delivered from that
   isolate.
8. Remove the DSN and confirm the application still starts and capture calls are
   no-ops.
9. With content capture off, inspect a trace and confirm prompts, model output,
   tool values, and secrets were not exported.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in `sentry.ts`.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.

### Version 2 — 2026-06-16

Remove the runtime event-type filter. The bridge continues to branch on the event variants it handles.

```diff
--- a/src/sentry.ts
+++ b/src/sentry.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: tooling/sentry@1
+// flue-blueprint: tooling/sentry@2
@@ -39,51 +39,46 @@ const runTags = new Map<string, Record<string, string>>();
-observe(
-  (event) => {
-    if (event.type === 'run_start' || event.type === 'run_resume') {
-      runTags.set(event.runId, { 'flue.workflow': event.workflowName });
-      return;
-    }
+observe((event) => {
+  if (event.type === 'run_start' || event.type === 'run_resume') {
+    runTags.set(event.runId, { 'flue.workflow': event.workflowName });
+    return;
+  }

-    const tags = correlationTags(event);
+  const tags = correlationTags(event);

-    if (event.type === 'run_end') {
-      runTags.delete(event.runId);
-      if (!event.isError) return;
-      captureException(event.error, tags, { durationMs: event.durationMs });
-      return;
-    }
+  if (event.type === 'run_end') {
+    runTags.delete(event.runId);
+    if (!event.isError) return;
+    captureException(event.error, tags, { durationMs: event.durationMs });
+    return;
+  }

-    if (event.type === 'operation' && event.isError && !event.runId) {
-      captureException(event.error, tags, {
-        durationMs: event.durationMs,
-        operationKind: event.operationKind,
-      });
-      return;
-    }
+  if (event.type === 'operation' && event.isError && !event.runId) {
+    captureException(event.error, tags, {
+      durationMs: event.durationMs,
+      operationKind: event.operationKind,
+    });
+    return;
+  }

-    if (event.type === 'submission_settled' && event.outcome === 'failed') {
-      captureException(event.error, tags);
-      return;
-    }
+  if (event.type === 'submission_settled' && event.outcome === 'failed') {
+    captureException(event.error, tags);
+    return;
+  }

-    if (event.type === 'log' && event.level === 'error') {
-      Sentry.withScope((scope) => {
-        scope.setTags(tags);
-        scope.setLevel('error');
-        if (Object.hasOwn(event.attributes ?? {}, 'error')) {
-          Sentry.captureException(toError(event.attributes?.error));
-        } else {
-          Sentry.captureMessage(event.message, 'error');
-        }
-      });
-    }
-  },
-  {
-    types: ['run_start', 'run_resume', 'run_end', 'operation', 'submission_settled', 'log'],
-  },
-);
+  if (event.type === 'log' && event.level === 'error') {
+    Sentry.withScope((scope) => {
+      scope.setTags(tags);
+      scope.setLevel('error');
+      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
+        Sentry.captureException(toError(event.attributes?.error));
+      } else {
+        Sentry.captureMessage(event.message, 'error');
+      }
+    });
+  }
+});
```

### Version 3 — 2026-07-14

Add AI tracing and log forwarding to the error-reporting bridge. When `SENTRY_TRACES_SAMPLE_RATE > 0` (default `0`), register Flue's OpenTelemetry instrumentation for the workflow/agent/model/tool span hierarchy with `traceLifecycle: 'stream'`; forward every `ctx.log.*` to Sentry Logs; and stop promoting error logs to issues, so issues remain limited to terminal failures. Content capture stays off by default and is controlled only by the record flags, not `sendDefaultPii`. The diff below is the Node `sentry.ts`; on Cloudflare, initialize the SDK through the Durable Object wrapper instead of `Sentry.init(...)` and re-export `cloudflare` from each agent and workflow module.

```diff
--- a/src/sentry.ts
+++ b/src/sentry.ts
@@ -1,101 +1,196 @@
-// flue-blueprint: tooling/sentry@2
-import { type FlueEvent, observe } from '@flue/runtime';
+// flue-blueprint: tooling/sentry@3
+
+import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
+import { type FlueEvent, instrument, observe } from '@flue/runtime';
 import * as Sentry from '@sentry/node';

+const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
+const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
+const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);
+
+const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
+	'Anthropic_AI',
+	'OpenAI',
+	'Google_GenAI',
+	'LangChain',
+	'LangGraph',
+	'VercelAI',
+]);
+
 Sentry.init({
-  dsn: process.env.SENTRY_DSN,
-  enabled: Boolean(process.env.SENTRY_DSN),
-  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
-  release: process.env.SENTRY_RELEASE,
-  attachStacktrace: true,
-  tracesSampleRate: 0,
+	dsn: process.env.SENTRY_DSN,
+	enabled: Boolean(process.env.SENTRY_DSN),
+	environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
+	release: process.env.SENTRY_RELEASE,
+	attachStacktrace: true,
+	tracesSampleRate,
+	traceLifecycle: 'stream',
+	streamGenAiSpans: true,
+	enableLogs: true,
+	integrations: (defaults) =>
+		defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
 });

+if (tracesSampleRate > 0) {
+	instrument(
+		createOpenTelemetryInstrumentation({
+			content: {
+				enabled: recordInputs || recordOutputs,
+				transform(content, scope) {
+					if (isInputContent(scope.contentType) && !recordInputs) return undefined;
+					if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
+					return scrub(content);
+				},
+				limits: { maxAttributeBytes: 16_384, maxMessageParts: 32, maxToolDefinitions: 32 },
+			},
+		}),
+	);
+}
+
 const runTags = new Map<string, Record<string, string>>();

 observe((event) => {
-  if (event.type === 'run_start' || event.type === 'run_resume') {
-    runTags.set(event.runId, { 'flue.workflow': event.workflowName });
-    return;
-  }
+	if (event.type === 'run_start' || event.type === 'run_resume') {
+		runTags.set(event.runId, { 'flue.workflow': event.workflowName });
+		return;
+	}

-  const tags = correlationTags(event);
+	const tags = correlationTags(event);

-  if (event.type === 'run_end') {
-    runTags.delete(event.runId);
-    if (!event.isError) return;
-    captureException(event.error, tags, { durationMs: event.durationMs });
-    return;
-  }
-
-  if (event.type === 'operation' && event.isError && !event.runId) {
-    captureException(event.error, tags, {
-      durationMs: event.durationMs,
-      operationKind: event.operationKind,
-    });
-    return;
-  }
-
-  if (event.type === 'submission_settled' && event.outcome === 'failed') {
-    captureException(event.error, tags);
-    return;
-  }
-
-  if (event.type === 'log' && event.level === 'error') {
-    Sentry.withScope((scope) => {
-      scope.setTags(tags);
-      scope.setLevel('error');
-      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
-        Sentry.captureException(toError(event.attributes?.error));
-      } else {
-        Sentry.captureMessage(event.message, 'error');
-      }
-    });
-  }
+	if (event.type === 'run_end') {
+		runTags.delete(event.runId);
+		if (event.isError) captureIncident(event.error, tags, { durationMs: event.durationMs });
+		return;
+	}
+	if (event.type === 'operation' && event.isError && !event.runId) {
+		captureIncident(event.error, tags, {
+			durationMs: event.durationMs,
+			operationKind: event.operationKind,
+		});
+		return;
+	}
+	if (event.type === 'submission_settled' && event.outcome === 'failed') {
+		captureIncident(event.error, tags);
+		return;
+	}
+	if (event.type === 'log') {
+		const attributes = logAttributes(event);
+		if (event.level === 'info') Sentry.logger.info(event.message, attributes);
+		else if (event.level === 'warn') Sentry.logger.warn(event.message, attributes);
+		else Sentry.logger.error(event.message, attributes);
+	}
 });

-function captureException(
-  error: unknown,
-  tags: Record<string, string>,
-  context?: Record<string, unknown>,
+// Flush buffered events (notably Sentry Logs) on shutdown. This never calls
+// process.exit, so it does not race or override Flue's own SIGINT/SIGTERM
+// handling — it just flushes within the graceful-stop window Flue already keeps
+// open.
+if (process.env.SENTRY_DSN) {
+	const flush = () => void Sentry.flush(2000);
+	process.once('SIGINT', flush);
+	process.once('SIGTERM', flush);
+}
+
+function captureIncident(
+	error: unknown,
+	tags: Record<string, string>,
+	context?: Record<string, unknown>,
 ): void {
-  Sentry.withScope((scope) => {
-    scope.setTags(tags);
-    scope.setLevel('error');
-    if (context) scope.setContext('flue.incident', context);
-    Sentry.captureException(toError(error));
-  });
+	Sentry.withScope((scope) => {
+		scope.setTags(tags);
+		scope.setLevel('error');
+		if (context) scope.setContext('flue.incident', context);
+		Sentry.captureException(toError(error));
+	});
 }

 function correlationTags(event: FlueEvent): Record<string, string> {
-  const tags: Record<string, string> = event.runId ? { ...runTags.get(event.runId) } : {};
-  if (event.runId) tags['flue.run.id'] = event.runId;
-  if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
-  if (event.dispatchId) tags['flue.dispatch.id'] = event.dispatchId;
-  if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
-  if (event.harness) tags['flue.harness'] = event.harness;
-  if (event.session) tags['flue.session'] = event.session;
-  if (event.operationId) tags['flue.operation.id'] = event.operationId;
-  if (event.taskId) tags['flue.task.id'] = event.taskId;
-  return tags;
+	const tags: Record<string, string> = event.runId ? { ...runTags.get(event.runId) } : {};
+	if (event.runId) tags['flue.run.id'] = event.runId;
+	if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
+	if (event.agentName) tags['flue.agent.name'] = event.agentName;
+	if (event.dispatchId) tags['flue.dispatch.id'] = event.dispatchId;
+	if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
+	if (event.conversationId) tags['flue.conversation.id'] = event.conversationId;
+	if (event.harness) tags['flue.harness'] = event.harness;
+	if (event.session) tags['flue.session'] = event.session;
+	if (event.operationId) tags['flue.operation.id'] = event.operationId;
+	if (event.taskId) tags['flue.task.id'] = event.taskId;
+	return tags;
 }

+type LogAttribute = string | number | boolean;
+
+function logAttributes(event: Extract<FlueEvent, { type: 'log' }>): Record<string, LogAttribute> {
+	const attributes: Record<string, LogAttribute> = {};
+	for (const [key, value] of Object.entries(correlationTags(event))) attributes[key] = value;
+	for (const [key, value] of Object.entries(event.attributes ?? {})) {
+		const scrubbed = scrub(value);
+		attributes[`flue.log.${key}`] =
+			typeof scrubbed === 'string' || typeof scrubbed === 'number' || typeof scrubbed === 'boolean'
+				? scrubbed
+				: stringify(scrubbed);
+	}
+	return attributes;
+}
+
+function isInputContent(contentType: string): boolean {
+	return (
+		contentType === 'input_messages' ||
+		contentType === 'system_instructions' ||
+		contentType === 'tool_definitions' ||
+		contentType === 'tool_description' ||
+		contentType === 'tool_arguments'
+	);
+}
+
+function isOutputContent(contentType: string): boolean {
+	return (
+		contentType === 'output_messages' ||
+		contentType === 'tool_result' ||
+		contentType === 'exception_message'
+	);
+}
+
+const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;
+
+function scrub(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
+	if (depth > 8) return '[truncated]';
+	if (value instanceof Error) return { name: value.name, message: value.message };
+	if (value === null || typeof value !== 'object') return value;
+	if (seen.has(value)) return '[circular]';
+	seen.add(value);
+	if (Array.isArray(value)) return value.map((item) => scrub(item, seen, depth + 1));
+	return Object.fromEntries(
+		Object.entries(value).map(([key, nested]) => [
+			key,
+			SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(nested, seen, depth + 1),
+		]),
+	);
+}
+
 function toError(value: unknown): Error {
-  if (value instanceof Error) return value;
-  if (value && typeof value === 'object') {
-    const source = value as { name?: unknown; message?: unknown; stack?: unknown };
-    const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
-    if (typeof source.name === 'string') error.name = source.name;
-    if (typeof source.stack === 'string') error.stack = source.stack;
-    return error;
-  }
-  return new Error(typeof value === 'string' ? value : stringify(value));
+	if (value instanceof Error) return value;
+	if (value && typeof value === 'object') {
+		const source = value as { name?: unknown; message?: unknown; stack?: unknown };
+		const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
+		if (typeof source.name === 'string') error.name = source.name;
+		if (typeof source.stack === 'string') error.stack = source.stack;
+		return error;
+	}
+	return new Error(typeof value === 'string' ? value : stringify(value));
 }

 function stringify(value: unknown): string {
-  try {
-    return JSON.stringify(value) ?? String(value);
-  } catch {
-    return String(value);
-  }
+	try {
+		return JSON.stringify(value) ?? String(value);
+	} catch {
+		return String(value);
+	}
 }
+
+function clampRate(value: string | undefined, fallback: number): number {
+	if (value === undefined) return fallback;
+	const parsed = Number(value);
+	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
+}
```
