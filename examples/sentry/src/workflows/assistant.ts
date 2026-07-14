import {
	defineAgent,
	defineWorkflow,
	type WorkflowRouteHandler,
	type WorkflowRunsHandler,
} from '@flue/runtime';
import * as v from 'valibot';
import { DEFAULT_MODEL, lookupOrder, supportInstructions } from '../support.ts';

export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

const agent = defineAgent(() => ({
	model: DEFAULT_MODEL,
	instructions: supportInstructions,
	tools: [lookupOrder],
}));

export default defineWorkflow({
	agent,
	input: v.object({ message: v.optional(v.string()) }),
	async run({ harness, input, log }) {
		const message = input.message ?? 'Where is demo order A123?';
		log.info('assistant run started', { message_length: message.length });

		const session = await harness.session();
		const response = await session.prompt(message);

		log.info('assistant run completed', {
			model: `${response.model.provider}/${response.model.id}`,
			output_tokens: response.usage.output,
			total_cost: response.usage.cost.total,
		});

		return { reply: response.text };
	},
});
