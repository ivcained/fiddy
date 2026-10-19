/**
 * Scheduled tasks, as the client can honestly hold them.
 *
 * The agent service exposes chat, lifecycle and channels but no scheduling
 * endpoint yet, and this client will not pretend otherwise. A schedule is
 * therefore two things: a plain-English request the owner sends to their agent
 * through chat (the agent writes its own cron entry on its side), and a local
 * record of that request so the UI can show what was asked for, when, and how
 * the agent answered.
 *
 * The record is a request log, not a scheduler. It says "asked", never "running".
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

const NAMESPACE = 'fiddy.agent.schedules';

export type ScheduleState = 'requested' | 'answered' | 'failed';

export interface ScheduleRequest {
  id: string;
  agentId: string;
  /** What the owner asked for, in their own words. */
  prompt: string;
  state: ScheduleState;
  createdAt: number;
  /** The agent's reply, trimmed — the only evidence the schedule was written. */
  reply?: string;
}

const keyFor = (agentId: string): string => `${NAMESPACE}.${agentId}`;

const isSchedule = (value: unknown): value is ScheduleRequest => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<ScheduleRequest>;
  return (
    typeof item.id === 'string' &&
    typeof item.agentId === 'string' &&
    typeof item.prompt === 'string' &&
    typeof item.createdAt === 'number' &&
    (item.state === 'requested' ||
      item.state === 'answered' ||
      item.state === 'failed')
  );
};

export const loadSchedules = async (
  agentId: string,
): Promise<ScheduleRequest[]> => {
  const stored = await getItem<unknown>({
    key: keyFor(agentId),
    fallback: [],
  });
  return Array.isArray(stored) ? stored.filter(isSchedule) : [];
};

export const saveSchedules = async (
  agentId: string,
  schedules: ScheduleRequest[],
): Promise<void> => {
  await setItem({ key: keyFor(agentId), value: schedules });
};

export const clearSchedules = (agentId: string): Promise<void> =>
  deleteItem(keyFor(agentId));

/** A stable-enough id without pulling in a dependency for three fields. */
export const newScheduleId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const upsertSchedule = (
  schedules: ScheduleRequest[],
  next: ScheduleRequest,
): ScheduleRequest[] => {
  const index = schedules.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...schedules];
  }
  const copy = schedules.slice();
  copy[index] = next;
  return copy;
};
