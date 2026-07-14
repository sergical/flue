import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const DEFAULT_MODEL = 'anthropic/claude-haiku-4-5';

export const supportInstructions =
	'You are a concise order-support agent. Always call lookup_order before answering a question about an order.';

export const lookupOrder = defineTool({
	name: 'lookup_order',
	description: 'Look up the status of a demo order by its id.',
	input: v.object({ orderId: v.string() }),
	run: async ({ input }) => ({
		orderId: input.orderId,
		status: 'shipped',
		eta: 'tomorrow',
		carrier: 'Flue Parcel Service',
	}),
});
