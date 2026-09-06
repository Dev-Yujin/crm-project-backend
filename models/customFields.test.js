import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));

const mockRef = {
  once: vi.fn(),
  update: vi.fn(async () => {}),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  push: vi.fn(),
};
const mockDb = { ref: vi.fn(() => mockRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
}));

const {
  CUSTOM_FIELD_TYPES,
  getFieldDefinitions,
  addFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
  validateCustomFieldValues,
  toStoredCustomFields,
  fromStoredCustomFields,
} = await import('./customFields.js');

const allDefinitions = {
  f1: { groupId: 'g1', entityType: 'TASK', name: 'PO number', type: 'TEXT', options: null },
  f2: { groupId: 'g1', entityType: 'TASK', name: 'Priority score', type: 'NUMBER', options: null },
  f3: { groupId: 'g1', entityType: 'TASK', name: 'Due by', type: 'DATE', options: null },
  f4: { groupId: 'g1', entityType: 'TASK', name: 'Region', type: 'DROPDOWN', options: ['North', 'South'] },
  f5: { groupId: 'g1', entityType: 'CLIENT', name: 'Industry', type: 'TEXT', options: null },
  f6: { groupId: 'g2', entityType: 'TASK', name: 'Other group field', type: 'TEXT', options: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRef.once.mockResolvedValue({ exists: () => true, val: () => allDefinitions });
});

describe('getFieldDefinitions', () => {
  it('filters by entityType and groupId', async () => {
    const result = await getFieldDefinitions('TASK', 'g1');
    expect(result.map((d) => d.id).sort()).toEqual(['f1', 'f2', 'f3', 'f4']);
  });

  it('returns empty array when no definitions match', async () => {
    const result = await getFieldDefinitions('CLIENT', 'g2');
    expect(result).toEqual([]);
  });
});

describe('addFieldDefinition', () => {
  beforeEach(() => {
    mockRef.push.mockReturnValue({ key: 'new-field', set: mockRef.set });
  });

  it('creates a non-dropdown field with options forced to null', async () => {
    const result = await addFieldDefinition(
      { entityType: 'TASK', name: 'Notes', type: CUSTOM_FIELD_TYPES.TEXT, options: null },
      'g1',
    );
    expect(mockRef.set).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', entityType: 'TASK', name: 'Notes', type: 'TEXT', options: null }),
    );
    expect(result.id).toBe('new-field');
  });

  it('creates a dropdown field, keeping its options', async () => {
    await addFieldDefinition(
      { entityType: 'TASK', name: 'Region', type: CUSTOM_FIELD_TYPES.DROPDOWN, options: ['A', 'B'] },
      'g1',
    );
    expect(mockRef.set).toHaveBeenCalledWith(expect.objectContaining({ options: ['A', 'B'] }));
  });

  it('rejects a dropdown field with no options', async () => {
    await expect(
      addFieldDefinition({ entityType: 'TASK', name: 'Region', type: CUSTOM_FIELD_TYPES.DROPDOWN, options: [] }, 'g1'),
    ).rejects.toThrow('Dropdown fields require at least one option');
    expect(mockRef.set).not.toHaveBeenCalled();
  });
});

describe('updateFieldDefinition', () => {
  beforeEach(() => {
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => allDefinitions.f4 });
  });

  it('updates name and options', async () => {
    await updateFieldDefinition('f4', { name: 'Zone', options: ['East', 'West'] }, 'g1');
    expect(mockRef.update).toHaveBeenCalledWith({ name: 'Zone', options: ['East', 'West'] });
  });

  it('rejects clearing a dropdown field down to zero options', async () => {
    await expect(updateFieldDefinition('f4', { options: [] }, 'g1')).rejects.toThrow(
      'Dropdown fields require at least one option',
    );
    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('rejects when the field belongs to a different group', async () => {
    await expect(updateFieldDefinition('f4', { name: 'x' }, 'g2')).rejects.toThrow('Custom field not found');
  });
});

describe('deleteFieldDefinition', () => {
  it('removes the definition when it belongs to the caller group', async () => {
    mockRef.once.mockResolvedValue({ exists: () => true, val: () => allDefinitions.f1 });
    const result = await deleteFieldDefinition('f1', 'g1');
    expect(mockRef.remove).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('rejects when the field does not exist', async () => {
    mockRef.once.mockResolvedValue({ exists: () => false, val: () => null });
    await expect(deleteFieldDefinition('missing', 'g1')).rejects.toThrow('Custom field not found');
    expect(mockRef.remove).not.toHaveBeenCalled();
  });
});

describe('validateCustomFieldValues', () => {
  it('is a no-op when values is null or undefined', async () => {
    await expect(validateCustomFieldValues(null, 'TASK', 'g1')).resolves.toBeUndefined();
    await expect(validateCustomFieldValues(undefined, 'TASK', 'g1')).resolves.toBeUndefined();
  });

  it('accepts a valid value for each field type', async () => {
    await expect(
      validateCustomFieldValues(
        [
          { fieldId: 'f1', value: 'PO-123' },
          { fieldId: 'f2', value: '42' },
          { fieldId: 'f3', value: '2026-12-01' },
          { fieldId: 'f4', value: 'North' },
        ],
        'TASK',
        'g1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown fieldId', async () => {
    await expect(
      validateCustomFieldValues([{ fieldId: 'nope', value: 'x' }], 'TASK', 'g1'),
    ).rejects.toThrow('Custom field not found: nope');
  });

  it('rejects a fieldId that belongs to a different entityType', async () => {
    await expect(
      validateCustomFieldValues([{ fieldId: 'f5', value: 'x' }], 'TASK', 'g1'),
    ).rejects.toThrow('Custom field not found: f5');
  });

  it('rejects a dropdown value not among its options', async () => {
    await expect(
      validateCustomFieldValues([{ fieldId: 'f4', value: 'East' }], 'TASK', 'g1'),
    ).rejects.toThrow('Region must be one of: North, South');
  });

  it('rejects a non-numeric NUMBER value', async () => {
    await expect(
      validateCustomFieldValues([{ fieldId: 'f2', value: 'abc' }], 'TASK', 'g1'),
    ).rejects.toThrow('Priority score must be a number');
  });

  it('rejects an unparseable DATE value', async () => {
    await expect(
      validateCustomFieldValues([{ fieldId: 'f3', value: 'not-a-date' }], 'TASK', 'g1'),
    ).rejects.toThrow('Due by must be a valid date');
  });
});

describe('toStoredCustomFields / fromStoredCustomFields', () => {
  it('round-trips between array and object shapes', () => {
    const values = [{ fieldId: 'f1', value: 'PO-123' }, { fieldId: 'f2', value: '42' }];
    const stored = toStoredCustomFields(values);
    expect(stored).toEqual({ f1: 'PO-123', f2: '42' });
    expect(fromStoredCustomFields(stored).sort((a, b) => a.fieldId.localeCompare(b.fieldId))).toEqual(values);
  });

  it('toStoredCustomFields distinguishes omitted (undefined) from explicit clear (null)', () => {
    expect(toStoredCustomFields(undefined)).toBeUndefined();
    expect(toStoredCustomFields(null)).toBeNull();
  });

  it('fromStoredCustomFields returns [] for a record with no customFields key', () => {
    expect(fromStoredCustomFields(undefined)).toEqual([]);
    expect(fromStoredCustomFields(null)).toEqual([]);
  });
});
