# Sentry observability for Flue

Complete observability for a Flue app with [Sentry](https://sentry.io):
trace-connected errors, logs, and AI traces.

The integration lives in [`src/sentry.ts`](src/sentry.ts), imported once from
[`src/app.ts`](src/app.ts). Agents and workflows never import Sentry.

## What you get

With a `SENTRY_DSN` set and `SENTRY_TRACES_SAMPLE_RATE > 0`:

- **Traces** — the full gen_ai hierarchy (`invoke_workflow` → `invoke_agent` →
  `chat` → `execute_tool`) as Sentry spans, with token usage and cost on the
  model spans.
- **Errors** — terminal failures (a failed workflow run, a failed top-level
  agent operation, a failed durable submission) become Sentry issues. Recovered
  nested tool/model failures stay on their span and do not raise issues.
- **Logs** — every `ctx.log.*` call is forwarded to Sentry Logs at its level.
- **Connected** — a run's spans, logs, and any issue share one `trace_id`.

Set `SENTRY_TRACES_SAMPLE_RATE=0` for errors + logs only.

## Files

```
examples/sentry/
├── src/
│   ├── sentry.ts            ← the integration
│   ├── app.ts               ← imports ./sentry.ts, mounts flue()
│   ├── support.ts           ← a demo lookup_order tool
│   └── workflows/
│       ├── assistant.ts     ← agent + tool → full gen_ai trace
│       ├── hello.ts         ← success, one info log
│       ├── boom.ts          ← fatal throw → one issue
│       └── explicit.ts      ← ctx.log.error → Sentry Logs
├── .env.example
├── flue.config.ts
└── package.json
```

## Run it

```bash
pnpm install
cp examples/sentry/.env.example examples/sentry/.env   # add SENTRY_DSN + ANTHROPIC_API_KEY
```

Start the server, then invoke each workflow over HTTP:

```bash
cd examples/sentry
pnpm exec flue dev --target node
```

```bash
curl -X POST 'http://localhost:3583/workflows/assistant?wait=result' \
  -H 'content-type: application/json' -d '{"message":"Where is demo order A123?"}'
curl -X POST 'http://localhost:3583/workflows/boom?wait=result' -H 'content-type: application/json'
curl -X POST 'http://localhost:3583/workflows/explicit?wait=result' -H 'content-type: application/json'
```

Each response carries a `runId` — the `flue.run.id` tag in Sentry. Open the
run's trace to see its spans, logs, and any issue together. Traces and issues
appear during the run; buffered logs flush when the server shuts down. Without a
`SENTRY_DSN` the SDK runs disabled and the app is unchanged.

## Cloudflare

This example targets Node. For the Cloudflare setup — where each agent and
workflow runs in its own Durable Object — run `flue add tooling sentry`, which
generates the target-specific initialization and Durable Object wrapper.
