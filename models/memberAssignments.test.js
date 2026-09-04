import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

const mockRootRef = { update: vi.fn(async () => {}) };
const mockDb = { ref: vi.fn(() => mockRootRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock('./task.js', () => ({
  getAllTasksForGroupIndexed: vi.fn(),
}));
vi.mock('./recurringTasks.js', () => ({
  getAllRecurringTasks: vi.fn(),
}));

const { getAllTasksForGroupIndexed } = await import('./task.js');
const { getAllRecurringTasks } = await import('./recurringTasks.js');
const { countMemberAssignments, reassignMemberAssignments } = await import('./memberAssignments.js');

describe('countMemberAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts tasks and recurring tasks that reference the uuid, across both collections independently', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm2'] },
      { id: 't2', assignedMembers: ['m2'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([
      { id: 'rt1', assignedMembers: ['m1'] },
    ]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 1, recurringTaskCount: 1 });
  });

  it('returns zero counts for a member with no assignments', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1', assignedMembers: ['m2'] }]);
    getAllRecurringTasks.mockResolvedValue([]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 0, recurringTaskCount: 0 });
  });

  it('treats a record with no assignedMembers field as unassigned, not a crash', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1' }]);
    getAllRecurringTasks.mockResolvedValue([{ id: 'rt1' }]);

    const result = await countMemberAssignments('m1', 'g1');
    expect(result).toEqual({ taskCount: 0, recurringTaskCount: 0 });
  });
});

describe('reassignMemberAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRootRef.update.mockResolvedValue(undefined);
  });

  it('replaces the old uuid with the new one in both collections and reports counts', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm3'] },
      { id: 't2', assignedMembers: ['m3'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([
      { id: 'rt1', assignedMembers: ['m1'] },
    ]);

    const result = await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).toHaveBeenCalledWith({
      'tasks/t1/assignedMembers': ['m2', 'm3'],
      'recurringTasks/rt1/assignedMembers': ['m2'],
    });
    expect(result).toEqual({ tasksTransferred: 1, recurringTasksTransferred: 1 });
  });

  it('dedupes when the new uuid is already a co-assignee', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([
      { id: 't1', assignedMembers: ['m1', 'm2'] },
    ]);
    getAllRecurringTasks.mockResolvedValue([]);

    await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).toHaveBeenCalledWith({
      'tasks/t1/assignedMembers': ['m2'],
    });
  });

  it('does not call update when nothing references the old uuid', async () => {
    getAllTasksForGroupIndexed.mockResolvedValue([{ id: 't1', assignedMembers: ['m9'] }]);
    getAllRecurringTasks.mockResolvedValue([]);

    const result = await reassignMemberAssignments('m1', 'm2', 'g1');

    expect(mockRootRef.update).not.toHaveBeenCalled();
    expect(result).toEqual({ tasksTransferred: 0, recurringTasksTransferred: 0 });
  });
});
