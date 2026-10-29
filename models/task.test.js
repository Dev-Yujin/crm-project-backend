import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));
vi.mock('../config/supabase.js', () => ({ pool: { query: vi.fn() } }));

const mockRef = {
  once: vi.fn(),
  set: vi.fn(async () => {}),
  push: vi.fn(),
};
const mockDb = { ref: vi.fn(() => mockRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
  ServerValue: { TIMESTAMP: 'TIMESTAMP_PLACEHOLDER' },
}));

vi.mock('./taskStatuses.js', () => ({
  validateTaskStatusExists: vi.fn(async () => {}),
}));
vi.mock('./departments.js', () => ({
  validateDepartmentExists: vi.fn(async () => {}),
}));
vi.mock('./groups.js', () => ({
  validateUsersExist: vi.fn(async () => {}),
}));

// Same rationale as models/clients.test.js: custom-field validation reads a different
// RTDB path (customFieldDefinitions) than this file's own client-lookup path, so it's
// mocked directly rather than exercised through the one shared mockRef.
vi.mock('./customFields.js', async () => {
  const actual = await vi.importActual('./customFields.js');
  return {
    ...actual,
    validateCustomFieldValues: vi.fn(async () => {}),
  };
});

const { validateCustomFieldValues } = await import('./customFields.js');
const { addTask, editTask } = await import('./task.js');

const baseClientSnapshot = { groupId: 'g1', servicesAvailed: ['s1'] };
const baseTask = {
  clientId: 'c1',
  clientName: 'Acme',
  taskName: 'Old task',
  taskDescription: 'Old description',
  serviceId: 's1',
  assignedMembers: [],
  assignedUsers: [],
  groupId: 'g1',
  customFields: { f1: 'existing value' },
};

describe('addTask custom fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => baseClientSnapshot });
    mockRef.push.mockReturnValue({ key: 'new-task', set: mockRef.set });
  });

  it('stores provided custom field values', async () => {
    const result = await addTask(
      'c1', 'Acme', 'New task', 'desc', 's1', [], null, 'admin:1', 'MEDIUM', null, null, null, 'g1', null, null, [], null,
      [{ fieldId: 'f1', value: 'PO-1' }],
    );
    expect(validateCustomFieldValues).toHaveBeenCalledWith([{ fieldId: 'f1', value: 'PO-1' }], 'TASK', 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: { f1: 'PO-1' } }));
    expect(result.customFields).toEqual({ f1: 'PO-1' });
  });

  it('defaults to an empty customFields object when none are provided', async () => {
    await addTask('c1', 'Acme', 'New task', 'desc', 's1', [], null, 'admin:1', 'MEDIUM', null, null, null, 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: {} }));
  });
});

describe('editTask custom fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseTask }) });
  });

  it('leaves existing custom field values untouched when customFields is omitted', async () => {
    await editTask('t1', { taskName: 'Renamed' }, 'g1');
    expect(validateCustomFieldValues).not.toHaveBeenCalled();
    expect(mockRef.set).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'Renamed', customFields: { f1: 'existing value' } }),
    );
  });

  it('overwrites custom field values when customFields is provided', async () => {
    await editTask('t1', { customFields: [{ fieldId: 'f1', value: 'new value' }] }, 'g1');
    expect(validateCustomFieldValues).toHaveBeenCalledWith([{ fieldId: 'f1', value: 'new value' }], 'TASK', 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: { f1: 'new value' } }));
  });

  it('clears custom field values when customFields is explicitly null', async () => {
    await editTask('t1', { customFields: null }, 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: null }));
  });
});

describe('addTask with a name-only client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.push.mockReturnValue({ key: 'new-task', set: mockRef.set });
  });

  it('stores an empty clientId and the typed name when the service is in the group', async () => {
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ groupId: 'g1' }) });
    await addTask('', '  Walk-in Co ', 'New task', 'desc', 's1', [], null, 'admin:1', 'MEDIUM', null, null, null, 'g1');
    expect(mockDb.ref).toHaveBeenCalledWith('services/s1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ clientId: '', clientName: 'Walk-in Co' }));
  });

  it('rejects a blank client name', async () => {
    await expect(
      addTask('', '  ', 'New task', 'desc', 's1', [], null, 'admin:1', 'MEDIUM', null, null, null, 'g1'),
    ).rejects.toThrow('Client name is required');
  });

  it("rejects a service from another group", async () => {
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ groupId: 'other' }) });
    await expect(
      addTask('', 'Walk-in Co', 'New task', 'desc', 's1', [], null, 'admin:1', 'MEDIUM', null, null, null, 'g1'),
    ).rejects.toThrow('Service not found');
  });
});

describe('editTask timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({ ...baseTask, liveLink: 'https://old.example', statusId: 'st1' }),
    });
  });

  it('stamps liveLinkAt when the link changes', async () => {
    await editTask('t1', { liveLink: 'https://new.example' }, 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ liveLinkAt: expect.any(Number) }));
  });

  it('leaves liveLinkAt alone when the same link is re-saved', async () => {
    await editTask('t1', { liveLink: 'https://old.example' }, 'g1');
    expect(mockRef.set.mock.calls[0][0]).not.toHaveProperty('liveLinkAt');
  });

  it('stamps statusChangedAt only when the status changes', async () => {
    await editTask('t1', { statusId: 'st1' }, 'g1');
    expect(mockRef.set.mock.calls[0][0]).not.toHaveProperty('statusChangedAt');
    await editTask('t1', { statusId: 'st2' }, 'g1');
    expect(mockRef.set.mock.calls[1][0]).toHaveProperty('statusChangedAt');
  });
});
