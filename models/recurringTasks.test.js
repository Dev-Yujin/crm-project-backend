import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

const mockRef = {
  once: vi.fn(),
  update: vi.fn(async () => {}),
};
const mockDb = { ref: vi.fn(() => mockRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

vi.mock('./task.js', async () => {
  const actual = await vi.importActual('./task.js');
  return {
    ...actual,
    validateMembersExist: vi.fn(async () => {}),
    validateServiceForClient: vi.fn(async () => {}),
    addTask: vi.fn(async () => ({})),
  };
});
vi.mock('./groups.js', () => ({
  validateUsersExist: vi.fn(async () => {}),
}));
vi.mock('./departments.js', () => ({
  validateDepartmentExists: vi.fn(async () => {}),
}));
vi.mock('./billing.js', () => ({
  isGroupLocked: vi.fn(async () => false),
}));

const { validateMembersExist, validateServiceForClient, addTask } = await import('./task.js');
const { validateUsersExist } = await import('./groups.js');
const { validateDepartmentExists } = await import('./departments.js');
const { isGroupLocked } = await import('./billing.js');
const { editRecurringTask, runDueRecurringTasks, RECURRENCE } = await import('./recurringTasks.js');

const baseTemplate = {
  clientId: 'c1',
  clientName: 'Acme',
  taskName: 'Old name',
  taskDescription: 'Old description',
  serviceId: 's1',
  assignedMembers: ['m1'],
  assignedUsers: ['u1'],
  priority: 'MEDIUM',
  recurrence: 'DAILY',
  createdBy: 'admin:1',
  active: true,
  lastRunAt: 1000,
  nextRunAt: 2000,
  departmentId: 'd1',
  groupId: 'g1',
};

describe('editRecurringTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({ ...baseTemplate }),
    });
    mockRef.update.mockResolvedValue(undefined);
  });

  it('updates only the fields passed, leaving nextRunAt/lastRunAt/active untouched', async () => {
    await editRecurringTask('rt1', { taskName: 'New name' }, 'g1');

    expect(mockRef.update).toHaveBeenCalledWith({ taskName: 'New name' });
  });

  it('rejects when the template does not exist', async () => {
    mockRef.once.mockResolvedValue({ exists: () => false, val: () => null });

    await expect(editRecurringTask('missing', { taskName: 'x' }, 'g1')).rejects.toThrow(
      'Recurring task not found',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('rejects when the template belongs to a different group', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({ ...baseTemplate, groupId: 'other-group' }),
    });

    await expect(editRecurringTask('rt1', { taskName: 'x' }, 'g1')).rejects.toThrow(
      'Recurring task not found',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('validates assignedMembers only when it is being changed', async () => {
    await editRecurringTask('rt1', { assignedMembers: ['m2'] }, 'g1');
    expect(validateMembersExist).toHaveBeenCalledWith(['m2'], 'g1');

    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseTemplate }) });
    await editRecurringTask('rt1', { taskName: 'New name' }, 'g1');
    expect(validateMembersExist).not.toHaveBeenCalled();
  });

  it('validates assignedUsers only when it is being changed', async () => {
    await editRecurringTask('rt1', { assignedUsers: ['u2'] }, 'g1');
    expect(validateUsersExist).toHaveBeenCalledWith(['u2'], 'g1');
  });

  it('validates the client/service pair, falling back to the stored value for whichever was not passed', async () => {
    await editRecurringTask('rt1', { clientId: 'c2' }, 'g1');
    expect(validateServiceForClient).toHaveBeenCalledWith('c2', 's1', 'g1');

    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseTemplate }) });
    await editRecurringTask('rt1', { serviceId: 's2' }, 'g1');
    expect(validateServiceForClient).toHaveBeenCalledWith('c1', 's2', 'g1');
  });

  it('validates departmentId only when it is being changed', async () => {
    await editRecurringTask('rt1', { departmentId: 'd2' }, 'g1');
    expect(validateDepartmentExists).toHaveBeenCalledWith('d2', 'g1');
  });

  it('dedupes assignedUsers when provided', async () => {
    await editRecurringTask('rt1', { assignedUsers: ['u2', 'u2', 'u3'] }, 'g1');
    expect(mockRef.update).toHaveBeenCalledWith({ assignedUsers: ['u2', 'u3'] });
  });

  it('rejects an explicit null recurrence instead of clearing it', async () => {
    await expect(editRecurringTask('rt1', { recurrence: null }, 'g1')).rejects.toThrow(
      'recurrence cannot be cleared',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('rejects an explicit null taskName instead of clearing it', async () => {
    await expect(editRecurringTask('rt1', { taskName: null }, 'g1')).rejects.toThrow(
      'taskName cannot be cleared',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('still allows clearing departmentId with an explicit null', async () => {
    await editRecurringTask('rt1', { departmentId: null }, 'g1');
    expect(mockRef.update).toHaveBeenCalledWith({ departmentId: null });
  });

  it('validates clientId and serviceId together using the two new values, not a stored+new mix', async () => {
    await editRecurringTask('rt1', { clientId: 'c2', serviceId: 's2' }, 'g1');
    expect(validateServiceForClient).toHaveBeenCalledWith('c2', 's2', 'g1');
  });
});

describe('runDueRecurringTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.update.mockResolvedValue(undefined);
    isGroupLocked.mockResolvedValue(false);
    addTask.mockResolvedValue({});
  });

  it('skips a template with an invalid/missing recurrence instead of hanging, and does not process it', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({
        rt1: {
          ...baseTemplate,
          recurrence: undefined,
          nextRunAt: 1, // due
          active: true,
        },
      }),
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runDueRecurringTasks();

    expect(result).toEqual([]);
    expect(addTask).not.toHaveBeenCalled();
    expect(mockRef.update).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid recurrence'),
    );

    consoleErrorSpy.mockRestore();
  });

  it('processes a template with a valid recurrence normally', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({
        rt1: {
          ...baseTemplate,
          id: 'rt1',
          recurrence: RECURRENCE.DAILY,
          nextRunAt: 1, // due
          active: true,
        },
      }),
    });

    const result = await runDueRecurringTasks();

    expect(result).toHaveLength(1);
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(mockRef.update).toHaveBeenCalledWith(
      expect.objectContaining({ lastRunAt: expect.any(Number), nextRunAt: expect.any(Number) }),
    );
  });
});
