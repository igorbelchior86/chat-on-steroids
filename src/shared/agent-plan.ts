import { z } from 'zod';

/** Codex's update_plan contract, with optional per-step detail for the desktop view. */
export const agentPlanUpdateSchema = z.object({
  explanation: z.string().trim().max(1000).optional().describe('Brief explanation of a changed plan.'),
  plan: z.array(z.object({
    step: z.string().trim().min(1).max(160).describe('Short headline shown to the user.'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    details: z.string().trim().max(2000).optional().describe('Concrete approach, checks or remaining work beneath this headline. Keep useful detail when updating status.')
  }).strict()).max(12)
    .refine(steps => steps.filter(step => step.status === 'in_progress').length <= 1, 'At most one step may be in_progress.')
    .refine(steps => steps.reduce((size, step) => size + step.step.length + (step.details?.length ?? 0), 0) <= 12000, 'Keep the complete plan below 12,000 characters.')
    .describe('The complete updated plan. Send an empty array to clear it.')
}).strict();

const activeAgentPlanLifecycleSchema = z.object({
  state: z.literal('active'),
  activatedAt: z.number().finite().nonnegative(),
  activatedAfterSeq: z.number().int().nonnegative(),
  activatedByTurnId: z.string().min(1).max(240).nullable()
}).strict();

const pausedAgentPlanLifecycleSchema = z.object({
  state: z.literal('paused'),
  activatedAt: z.number().finite().nonnegative(),
  activatedAfterSeq: z.number().int().nonnegative(),
  activatedByTurnId: z.string().min(1).max(240).nullable(),
  pausedAt: z.number().finite().nonnegative(),
  pausedByTurnId: z.string().min(1).max(240),
  pausedBySeq: z.number().int().positive()
}).strict();

export const agentPlanLifecycleSchema = z.discriminatedUnion('state', [
  activeAgentPlanLifecycleSchema,
  pausedAgentPlanLifecycleSchema
]);

export const agentPlanSchema = agentPlanUpdateSchema.extend({
  updatedAt: z.number().finite().nonnegative(),
  // Optional only for plan.json written by pre-lifecycle releases. New writes always set it.
  lifecycle: agentPlanLifecycleSchema.optional()
});
export type AgentPlanUpdate = z.infer<typeof agentPlanUpdateSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** A paused document remains durable for multi-turn reconciliation but is not current UI state. */
export function agentPlanIsVisible(plan: AgentPlan | null | undefined): plan is AgentPlan {
  return !!plan && plan.lifecycle?.state !== 'paused';
}

export function incompleteAgentPlanSteps(plan: AgentPlan | null | undefined): AgentPlan['plan'] {
  return plan?.plan.filter(step => step.status !== 'completed') ?? [];
}

export function agentPlanNeedsReconciliation(plan: AgentPlan | null | undefined): plan is AgentPlan {
  return incompleteAgentPlanSteps(plan).length > 0;
}

/** Compact model-facing state for a follow-up/tool result; details stay in the durable tool call. */
export function agentPlanReconciliationInstructions(plan: AgentPlan): string {
  const completed = plan.plan.filter(step => step.status === 'completed').length;
  const rows = plan.plan.map((step, index) => `${index + 1}. [${step.status}] ${step.step}`).join('\n');
  return `A durable Agent Plan from earlier work needs reconciliation (${completed}/${plan.plan.length} completed).\n${rows}\n` +
    'If this instruction continues that work, call update_plan with the complete current plan and correct statuses before proceeding. ' +
    'If it supersedes that work or the work is actually finished, clear or complete the plan explicitly instead. Never mark unfinished work completed merely to dismiss the plan.';
}

/** UTF-8, including JSON escapes and the server timestamp; also the bounded disk-read size. */
export const MAX_AGENT_PLAN_BYTES = 96 * 1024;
