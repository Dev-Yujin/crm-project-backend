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
