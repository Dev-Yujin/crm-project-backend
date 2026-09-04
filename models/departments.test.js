import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));
vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));

const mockRef = {
  once: vi.fn(),
  update: vi.fn(async () => {}),
};
const mockDb = { ref: vi.fn(() => mockRef) };

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
  ServerValue: { TIMESTAMP: 'TIMESTAMP' },
}));

const { removeMemberFromAllDepartments } = await import('./departments.js');

describe('removeMemberFromAllDepartments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRef.update.mockResolvedValue(undefined);
  });

  it('removes the member from every department that has them, leaving departments without them untouched', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({
        d1: {
          name: 'Dept1',
          groupId: 'g1',
          members: {
            m1: { username: 'alice', email: 'alice@x.com', assignedAt: 1 },
            m2: { username: 'bob', email: 'bob@x.com', assignedAt: 2 },
          },
        },
        d2: {
          name: 'Dept2',
          groupId: 'g1',
          members: {
            m1: { username: 'alice', email: 'alice@x.com', assignedAt: 3 },
          },
        },
        d3: {
          name: 'Dept3',
          groupId: 'g1',
          members: {
            m2: { username: 'bob', email: 'bob@x.com', assignedAt: 4 },
          },
        },
      }),
    });

    await removeMemberFromAllDepartments('m1', 'g1');

    expect(mockRef.update).toHaveBeenCalledWith({
      'departments/d1/members/m1': null,
      'departments/d2/members/m1': null,
    });
  });

  it('only removes the member from departments in the given group', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({
        d1: {
          name: 'Dept1',
          groupId: 'g1',
          members: { m1: { username: 'alice', email: 'alice@x.com', assignedAt: 1 } },
        },
        d2: {
          name: 'OtherGroupDept',
          groupId: 'other-group',
          members: { m1: { username: 'alice', email: 'alice@x.com', assignedAt: 1 } },
        },
      }),
    });

    await removeMemberFromAllDepartments('m1', 'g1');

    expect(mockRef.update).toHaveBeenCalledWith({
      'departments/d1/members/m1': null,
    });
  });

  it('does not call update when the member is not in any department', async () => {
    mockRef.once.mockResolvedValue({
      exists: () => true,
      val: () => ({
        d1: {
          name: 'Dept1',
          groupId: 'g1',
          members: { m2: { username: 'bob', email: 'bob@x.com', assignedAt: 1 } },
        },
      }),
    });

    await removeMemberFromAllDepartments('m1', 'g1');

    expect(mockRef.update).not.toHaveBeenCalled();
  });

  it('does not call update when there are no departments at all', async () => {
    mockRef.once.mockResolvedValue({ exists: () => false, val: () => null });

    await removeMemberFromAllDepartments('m1', 'g1');

    expect(mockRef.update).not.toHaveBeenCalled();
  });
});
