import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

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

vi.mock('./services.js', () => ({
  validateServicesExist: vi.fn(async () => {}),
}));

// clients.js touches only the `clients/{id}` path directly; custom-field validation is a
// separate collaborator that reads a different path (`customFieldDefinitions`) — mocked
// here rather than exercised through the shared mockRef, which only models one path at a
// time (see models/recurringTasks.test.js for the established precedent of mocking
// collaborator validators rather than sharing one ref across multiple RTDB paths).
vi.mock('./customFields.js', async () => {
  const actual = await vi.importActual('./customFields.js');
  return {
    ...actual,
    validateCustomFieldValues: vi.fn(async () => {}),
  };
});

const { validateCustomFieldValues } = await import('./customFields.js');
const { addClient, editClient } = await import('./clients.js');

const baseClient = {
  clientName: 'Old Name',
  businessName: 'Old Biz',
  email: 'old@example.com',
  whatsappNumber: null,
  clientNotes: null,
  servicesAvailed: null,
  groupId: 'g1',
  customFields: { f1: 'existing value' },
};

describe('addClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.push.mockReturnValue({ key: 'new-client', set: mockRef.set });
  });

  it('stores provided custom field values', async () => {
    const result = await addClient(
      'Jane',
      'Acme',
      'jane@example.com',
      null,
      null,
      null,
      'g1',
      [{ fieldId: 'f1', value: 'Retail' }],
    );
    expect(validateCustomFieldValues).toHaveBeenCalledWith([{ fieldId: 'f1', value: 'Retail' }], 'CLIENT', 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: { f1: 'Retail' } }));
    expect(result.customFields).toEqual({ f1: 'Retail' });
  });

  it('defaults to an empty customFields object when none are provided', async () => {
    await addClient('Jane', 'Acme', 'jane@example.com', null, null, null, 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: {} }));
  });
});

describe('editClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => ({ ...baseClient }) });
  });

  it('leaves existing custom field values untouched when customFields is omitted', async () => {
    await editClient('c1', { clientName: 'New Name' }, 'g1');
    expect(validateCustomFieldValues).not.toHaveBeenCalled();
    expect(mockRef.set).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: 'New Name', customFields: { f1: 'existing value' } }),
    );
  });

  it('overwrites custom field values when customFields is provided', async () => {
    await editClient('c1', { customFields: [{ fieldId: 'f1', value: 'new value' }] }, 'g1');
    expect(validateCustomFieldValues).toHaveBeenCalledWith([{ fieldId: 'f1', value: 'new value' }], 'CLIENT', 'g1');
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ customFields: { f1: 'new value' } }));
  });

  it('rejects when the client does not exist', async () => {
    mockRef.once.mockResolvedValue({ exists: () => false, val: () => null });
    await expect(editClient('missing', { clientName: 'x' }, 'g1')).rejects.toThrow('Client not found');
    expect(mockRef.set).not.toHaveBeenCalled();
  });
});
