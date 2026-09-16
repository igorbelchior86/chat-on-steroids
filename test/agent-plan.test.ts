import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { appendEvent, createSession, flushSessions, initSessionStore, readSessionPlan, rebindSession, resetSessionStoreForTests, sessionsRoot, updateSessionPlan } from '../src/main/session/store.js';
import { agentPlanIsVisible, agentPlanNeedsReconciliation, agentPlanReconciliationInstructions, agentPlanUpdateSchema, MAX_AGENT_PLAN_BYTES } from '../src/shared/agent-plan.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { prepareHandoff, resumeBootstrapMatches, resumeBootstrapText } from '../src/main/session/handoff.js';

let dir: string;
const update = { plan: [{ step: 'Fix the ownership boundary', status: 'in_progress' as const, details: 'Keep one durable session across replacement chats.' }] };
beforeAll(async () => { dir = await makeTempDir('clf-agent-plan-'); initSessionStore(dir); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await flushSessions(); resetSessionStoreForTests(); await removeTempDir(dir); });

it('adds a retrievable plan notice to the durable handoff only when a nonempty plan exists', async () => {
  const session = await createSession({ conversationId: 'plan-handoff' });
  const text = 'Continue the existing work and preserve the verified results. '.repeat(6);
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
  await updateSessionPlan(session.id, 'plan-handoff', update, 100);
  const handoff = await prepareHandoff({ sessionId: session.id, text });
  expect(handoff.text).toContain(`session_id="${session.id}"`);
  expect(handoff.text).toContain('latest update_plan');
  expect(handoff.text).not.toContain(update.plan[0]!.details);
  expect(resumeBootstrapMatches(resumeBootstrapText(handoff.text), handoff.text)).toBe(true);
  await updateSessionPlan(session.id, 'plan-handoff', { plan: [] }, 200);
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
});

it('persists a plan across restart and replacement, fencing old chats and older calls', async () => {
  const session = await createSession({ conversationId: 'plan-source' });
  const other = await createSession({ conversationId: 'plan-other' });
  expect(await updateSessionPlan(session.id, 'plan-source', update, 200)).toBe(true);
  expect(await readSessionPlan(other.id)).toBeNull();
  await flushSessions();
  resetSessionStoreForTests();
  initSessionStore(dir);
  expect(await readSessionPlan(session.id)).toEqual({
    ...update,
    updatedAt: 200,
    lifecycle: { state: 'active', activatedAt: 200, activatedAfterSeq: 0, activatedByTurnId: null }
  });
  expect(await rebindSession(session.id, 'plan-source', 'plan-destination')).toBe(true);
  expect(await updateSessionPlan(session.id, 'plan-source', { plan: [] }, 300)).toBe(false);
  expect(await updateSessionPlan(session.id, 'plan-destination', { plan: [] }, 100)).toBe(false);
  expect(await readSessionPlan(session.id)).toEqual({
    ...update,
    updatedAt: 200,
    lifecycle: { state: 'active', activatedAt: 200, activatedAfterSeq: 0, activatedByTurnId: null }
  });
  expect(await updateSessionPlan(session.id, 'plan-destination', { plan: [] }, 400)).toBe(true);
  expect((await readSessionPlan(session.id))?.plan).toEqual([]);
});

it('serializes a concurrent rebind before a delayed source update', async () => {
  const session = await createSession({ conversationId: 'plan-race-a' });
  await updateSessionPlan(session.id, 'plan-race-a', update, 100);
  const moved = rebindSession(session.id, 'plan-race-a', 'plan-race-b');
  const late = updateSessionPlan(session.id, 'plan-race-a', { plan: [] }, 200);
  expect(await moved).toBe(true);
  expect(await late).toBe(false);
  expect((await readSessionPlan(session.id))?.plan).toEqual(update.plan);
});

it('keeps the prior document on a failed atomic replacement and permits retry', async () => {
  const session = await createSession({ conversationId: 'plan-write' });
  await updateSessionPlan(session.id, 'plan-write', update, 100);
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(updateSessionPlan(session.id, 'plan-write', { plan: [] }, 200)).rejects.toThrow('disk unavailable');
  rename.mockRestore();
  expect((await readSessionPlan(session.id))?.plan).toEqual(update.plan);
  expect((await fs.readdir(path.join(sessionsRoot(), session.id))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(await updateSessionPlan(session.id, 'plan-write', { plan: [] }, 200)).toBe(true);
});

it('pauses an unfinished plan at a proven completed turn and only reopens it for the exact app repair', async () => {
  const session = await createSession({ conversationId: 'plan-lifecycle' });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 100 });
  expect(await updateSessionPlan(session.id, 'plan-lifecycle', update, 200)).toBe(true);
  expect(agentPlanIsVisible(await readSessionPlan(session.id))).toBe(true);

  await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 300 });
  const paused = await readSessionPlan(session.id);
  expect(agentPlanIsVisible(paused)).toBe(false);
  expect(agentPlanNeedsReconciliation(paused)).toBe(true);
  expect(paused?.plan).toEqual(update.plan);
  expect(paused?.lifecycle).toMatchObject({ state: 'paused', pausedByTurnId: 'turn-one' });

  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 400 });
  expect(agentPlanIsVisible(await readSessionPlan(session.id))).toBe(false);
  await appendEvent(session.id, { source: 'app', kind: 'turn_start', turnId: 'turn-one', time: 500 });
  expect(agentPlanIsVisible(await readSessionPlan(session.id))).toBe(true);
});

it('reactivates a paused plan through a newer update_plan and fences pre-pause calls', async () => {
  const session = await createSession({ conversationId: 'plan-reactivate' });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 100 });
  await updateSessionPlan(session.id, 'plan-reactivate', update, 200);
  await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 300 });
  const paused = await readSessionPlan(session.id);
  expect(paused?.lifecycle?.state).toBe('paused');
  expect(await updateSessionPlan(session.id, 'plan-reactivate', update, 250)).toBe(false);
  const newerAt = paused?.lifecycle?.state === 'paused' ? paused.lifecycle.pausedAt + 1 : Date.now() + 1;
  expect(await updateSessionPlan(session.id, 'plan-reactivate', update, newerAt)).toBe(true);
  expect(agentPlanIsVisible(await readSessionPlan(session.id))).toBe(true);
});

it('does not mint a new semantic revision for an identical update_plan, including paused reconciliation', async () => {
  const session = await createSession({ conversationId: 'plan-idempotent' });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 100 });
  expect(await updateSessionPlan(session.id, 'plan-idempotent', update, 200)).toBe(true);
  await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 300 });
  const paused = await readSessionPlan(session.id);
  expect(paused?.lifecycle?.state).toBe('paused');
  expect(paused?.updatedAt).toBe(200);

  const reconcileAt = (paused?.lifecycle?.state === 'paused' ? paused.lifecycle.pausedAt : 300) + 1;
  expect(await updateSessionPlan(session.id, 'plan-idempotent', update, reconcileAt)).toBe(true);
  const reconciled = await readSessionPlan(session.id);
  expect(reconciled?.lifecycle?.state).toBe('active');
  expect(reconciled?.updatedAt).toBe(200);

  expect(await updateSessionPlan(session.id, 'plan-idempotent', update, reconcileAt + 100)).toBe(true);
  const repeated = await readSessionPlan(session.id);
  expect(repeated).toEqual(reconciled);
});

it('pauses a legacy pre-lifecycle plan from recorded completion but not from an older completion', async () => {
  const session = await createSession({ conversationId: 'plan-legacy-upgrade' });
  const file = path.join(sessionsRoot(), session.id, 'plan.json');
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'legacy-turn', time: 100 });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'legacy-turn', outcome: 'completed', time: 300 });

  await fs.writeFile(file, JSON.stringify({ ...update, updatedAt: 200 }), 'utf8');
  const stale = await readSessionPlan(session.id);
  expect(agentPlanIsVisible(stale)).toBe(false);
  expect(stale?.lifecycle).toMatchObject({ state: 'paused', pausedByTurnId: 'legacy-turn' });

  await fs.writeFile(file, JSON.stringify({ ...update, updatedAt: 400 }), 'utf8');
  const newer = await readSessionPlan(session.id);
  expect(agentPlanIsVisible(newer)).toBe(true);
  expect(newer?.lifecycle).toBeUndefined();
});

it('gives the model a bounded explicit reconciliation instruction without inventing progress', () => {
  const plan = { ...update, updatedAt: 200 };
  const instructions = agentPlanReconciliationInstructions(plan);
  expect(instructions).toContain('0/1 completed');
  expect(instructions).toContain('[in_progress] Fix the ownership boundary');
  expect(instructions).toContain('call update_plan with the complete current plan');
  expect(instructions).not.toContain(update.plan[0]!.details);
});

it('bounds untrusted disk content and validates plan structure before writing', async () => {
  const session = await createSession({ conversationId: 'plan-corrupt' });
  const file = path.join(sessionsRoot(), session.id, 'plan.json');
  for (const bytes of ['{torn', 'x'.repeat(MAX_AGENT_PLAN_BYTES + 1), '{"plan":[],"updatedAt":-1}']) {
    await fs.writeFile(file, bytes);
    expect(await readSessionPlan(session.id)).toBeNull();
  }
  expect(agentPlanUpdateSchema.safeParse({ plan: [update.plan[0], update.plan[0]] }).success).toBe(false);
  expect(agentPlanUpdateSchema.safeParse({ ...update, session_id: session.id }).success).toBe(false);
  expect(agentPlanUpdateSchema.safeParse({ plan: [{ step: ' ', status: 'pending' }] }).success).toBe(false);
  expect(await updateSessionPlan(session.id, 'plan-corrupt', update, 300)).toBe(true);
});
