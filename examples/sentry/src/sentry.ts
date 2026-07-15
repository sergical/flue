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
	tracesSampleRate,
	traceLifecycle: 'stream',
	streamGenAiSpans: true,
	enableLogs: true,
	integrations: (defaults) =>
		defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
});

// `flue dev` re-evaluates this module on every reload, but @flue/runtime's
// instrumentation/observer registries and this process's signal listeners live
// outside the reloaded module graph. Without cleanup each edit stacks another
// bridge and double-reports logs, issues, and spans. Tear down the previous
// evaluation's registrations (kept on a process-global under a shared Symbol)
// before wiring new ones, and collect this evaluation's own teardowns.
const RELOAD_TEARDOWN = Symbol.for('flue.sentry.teardown');
const reloadStore = globalThis as unknown as { [key: symbol]: (() => void) | undefined };
reloadStore[RELOAD_TEARDOWN]?.();
const teardowns: Array<() => void> = [];

if (tracesSampleRate > 0) {
	const dispose = instrument(
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
	teardowns.push(() => void dispose());
}

const runTags = new Map<string, Record<string, string>>();
// A failed direct submission emits a rich `operation` failure (original error
// name/message + duration/kind) and, later, a `submission_settled` whose
// `serializeSubmissionError` collapses non-FlueError causes to a generic
// "internal error". Capture the operation and remember its submissionId so we
// drop the duplicate settlement while keeping the better error. Dispatched
// submissions carry a `dispatchId` and never settle through observe(), so they
// need no bookkeeping.
const capturedDirectSubmissions = new Set<string>();

teardowns.push(
	observe((event) => {
		if (event.type === 'run_start' || event.type === 'run_resume') {
			runTags.set(event.runId, { 'flue.workflow': event.workflowName });
			return;
		}

		const tags = correlationTags(event);

		if (event.type === 'run_end') {
			runTags.delete(event.runId);
			if (event.isError)
				captureTerminalFailure(event.error, tags, { durationMs: event.durationMs });
			return;
		}
		if (event.type === 'operation' && event.isError && !event.runId) {
			captureTerminalFailure(event.error, tags, {
				durationMs: event.durationMs,
				operationKind: event.operationKind,
			});
			if (event.submissionId && !event.dispatchId)
				capturedDirectSubmissions.add(event.submissionId);
			return;
		}
		if (event.type === 'submission_settled' && event.outcome === 'failed') {
			// Skip the duplicate of a direct-submission failure already captured
			// from its `operation`; capture only reconciled failures that settled
			// without a live operation in this isolate.
			if (event.submissionId && capturedDirectSubmissions.delete(event.submissionId)) return;
			captureTerminalFailure(event.error, tags);
			return;
		}
		if (event.type === 'log') {
			Sentry.logger[event.level](event.message, logAttributes(event));
		}
	}),
);

// Best-effort flush of buffered events (notably Sentry Logs) on shutdown. This
// never calls process.exit, so it cannot race or override Flue's own
// SIGINT/SIGTERM handling. It is NOT a delivery guarantee: Flue's generated
// server calls process.exit() right after `lifecycle.stop()` resolves, and Node
// does not await promises started by signal listeners, so an in-flight flush can
// be cut short when there is no other pending work. Traces and issues are sent
// during the run; only very-recently-buffered logs are at risk. A guaranteed
// drain needs a runtime-owned awaited shutdown hook (not yet exposed).
if (process.env.SENTRY_DSN) {
	const flush = () => void Sentry.flush(2000);
	process.on('SIGINT', flush);
	process.on('SIGTERM', flush);
	teardowns.push(() => {
		process.off('SIGINT', flush);
		process.off('SIGTERM', flush);
	});
}

// Publish this evaluation's teardown so the next `flue dev` reload undoes it.
reloadStore[RELOAD_TEARDOWN] = () => {
	for (const teardown of teardowns) teardown();
};

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
