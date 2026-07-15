---
title: Sentry
description: Send Flue errors, logs, and AI traces to Sentry on Node.js and Cloudflare.
lastReviewedAt: 2026-07-14
---

## Quickstart

Add Sentry observability to an existing Flue project with the [Sentry](https://sentry.io) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add tooling sentry
```

## Overview

On Node.js, the Sentry blueprint creates a source-root `sentry.ts` and imports it once from `app.ts`. The core of that generated bridge looks like this:

```ts title="src/sentry.ts (abridged)"
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument, observe } from '@flue/runtime';
import * as Sentry from '@sentry/node';

const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate,
  traceLifecycle: 'stream',
  streamGenAiSpans: true,
  enableLogs: true,
});

if (tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation(/* content policy */));
}

observe((event) => {
  const tags = correlationTags(event);

  if (event.type === 'run_end' && event.isError) {
    captureTerminalFailure(event.error, tags);
  }

  // The complete bridge also captures failed top-level agent operations and
  // durable submissions, while deduplicating their terminal events.

  if (event.type === 'log') {
    Sentry.logger[event.level](event.message, logAttributes(event));
  }
});

function captureTerminalFailure(
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
```

The complete initialization disables Sentry's overlapping AI provider integrations so Flue produces one AI span hierarchy. It keeps AI content out of traces unless the corresponding input or output recording variable is enabled. On Node.js, it also supplies terminal-failure deduplication, development-reload cleanup, and a best-effort shutdown flush for buffered logs omitted from this abridged example.

On Cloudflare, the generated `sentry.ts` contains the same instrumentation and observer bridge without calling `Sentry.init()`. The blueprint re-exports a module-local `cloudflare` extension from every discovered agent and workflow so the integration runs inside each Durable Object isolate. The extension wraps the final generated Durable Object class with `instrumentDurableObjectWithSentry(...)`, while leaving the outer Worker uninstrumented.

## Configure

| Variable                    | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | **Required for event delivery** — Identifies the Sentry project and permits event submission.        |
| `SENTRY_ENVIRONMENT`        | **Optional** — Identifies the deployment environment in Sentry.                                      |
| `SENTRY_RELEASE`            | **Optional** — Associates events with a deployed release.                                            |
| `SENTRY_TRACES_SAMPLE_RATE` | SDK-wide trace sample rate from `0` to `1`. Values above `0` also enable the Flue AI span hierarchy. |
| `SENTRY_AI_RECORD_INPUTS`   | Set to `true` to export prompts, system instructions, tool definitions, and tool arguments.          |
| `SENTRY_AI_RECORD_OUTPUTS`  | Set to `true` to export model output and tool results.                                               |

Only `SENTRY_DSN` is needed to deliver errors and logs. Tracing defaults to `0`; set `SENTRY_TRACES_SAMPLE_RATE` above `0` to add traces. The value is passed to the Sentry SDK and can sample non-AI instrumentation too. Customize the generated initialization with a `tracesSampler` when production traffic needs selective sampling.

A Sentry DSN permits event submission but does not grant read access to project data. Keeping it in deployment configuration rather than application source makes rotation and abuse mitigation easier; use a secret or environment binding according to your project's policy.

The blueprint installs `@sentry/node` or `@sentry/cloudflare`, initializes the SDK at the appropriate runtime boundary, and adds an `observe(...)` bridge for terminal failures and every `ctx.log.*` call. Tracing is disabled by default. When enabled, it includes token usage and cost but keeps prompts, model responses, tool arguments, and tool results out of traces unless their recording variables are explicitly enabled.

See [Observability](/docs/guide/observability/#choose-an-observability-provider) to compare Sentry with OpenTelemetry and Braintrust.

The integration uses different SDKs by target:

| Target     | Package              | Initialization                                                                                   |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| Node.js    | `@sentry/node`       | Module-scoped `Sentry.init(...)` in application source                                           |
| Cloudflare | `@sentry/cloudflare` | `instrumentDurableObjectWithSentry(...)` around each generated agent and workflow Durable Object |

Do not use `@sentry/node` on Cloudflare through `nodejs_compat`.

## Choose what to report

The generated bridge reports:

- failed workflow runs, failed top-level agent operations, and failed durable submissions as Sentry issues;
- every `ctx.log.info(...)`, `ctx.log.warn(...)`, and `ctx.log.error(...)` call to Sentry Logs at the corresponding level;
- when `SENTRY_TRACES_SAMPLE_RATE` is above `0`, the workflow → agent → model → tool span hierarchy with token usage and cost on model spans.

A workflow run's spans, logs, and issue share one trace. Captures include relevant `flue.*` correlation tags. Workflow failures include `flue.run.id`, which can be inspected with SDK `client.runs` or raw `/runs` APIs when the workflow exposes its run resources. Persistent-agent captures use instance, session, operation, submission, and optional dispatch correlation instead. See [Observability](/docs/guide/observability/) for Flue's identity and observer model.

Issues are limited to terminal failures. Recovered nested agent, model, and tool failures remain on their spans, and error logs are not promoted to issues.

AI recording flags apply only to trace content, not logs. Log messages are forwarded unchanged; attribute values pass through a generic secret-key scrubber. Do not put sensitive data in logs, and add application-specific redaction before enabling input or output recording.

## Target behavior

On Node.js, module-scoped initialization is sufficient for the bridge's explicit errors, logs, and Flue AI spans. Complete Sentry HTTP or database auto-instrumentation requires Sentry's preload setup before application imports and should be verified against the built Flue server.

On Cloudflare, Flue applies a module-local `wrap` extension to the final generated Durable Object class for every instrumented agent and workflow. This preserves Flue's routing and durability behavior while allowing Sentry to initialize from the current binding environment. The wrapper does not cover the outer Worker or an authored Hono application; add HTTP middleware separately when request instrumentation is required.

## Verify

Against a non-production Sentry project, set `SENTRY_TRACES_SAMPLE_RATE=1` and run a workflow that calls an agent and a tool. Confirm that one trace contains the workflow, agent, model, and tool spans; token usage and cost appear on model spans; and `ctx.log.*` entries appear in Sentry Logs on the same trace. Trigger one terminal workflow or top-level agent failure and confirm that it creates one issue with the expected `flue.*` correlation fields.

Keep both AI recording variables disabled and confirm prompts, model output, tool arguments, and tool results are absent. On Cloudflare, exercise a wrapped agent or workflow under workerd, and verify that the application still starts without a configured DSN. On Node.js, Sentry Logs are buffered, so logs written immediately before process exit can be lost despite the generated integration's best-effort shutdown flush.
