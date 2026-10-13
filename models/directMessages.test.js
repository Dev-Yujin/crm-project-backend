import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/firebase.js', () => ({ app: {} }));
vi.mock('../config/supabase.js', () => ({ pool: { query: vi.fn() } }));

const mockRef = { set: vi.fn(async () => {}) };
const mockDb = { ref: vi.fn(() => mockRef) };
vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn(() => mockDb),
  ServerValue: { TIMESTAMP: 'TIMESTAMP_PLACEHOLDER' },
}));
vi.mock('./groups.js', () => ({ getGroupUsers: vi.fn() }));

const { pool } = await import('../config/supabase.js');
const { getGroupUsers } = await import('./groups.js');
const {
  conversationKey,
  parseParticipantKey,
  sendDirectMessage,
  listDirectMessages,
  listDirectConversations,
  listChatContacts,
  markDirectConversationRead,
  MAX_MESSAGE_LENGTH,
} = await import('./directMessages.js');
const { resolveChatIdentity } = await import('../resolvers/directMessageResolvers.js');

const sender = { key: 'user_a', name: 'Eugene' };
const row = (over = {}) => ({
  id: 'm1',
  sender_key: 'user_a',
  recipient_key: 'member_b',
  sender_name: 'Eugene',
  body: 'hi',
  created_at: new Date(1000),
  read_at: null,
  ...over,
});

beforeEach(() => {
  pool.query.mockReset();
  mockDb.ref.mockClear();
  mockRef.set.mockClear();
});

describe('keys', () => {
  it('builds the same conversation key regardless of direction', () => {
    expect(conversationKey('user_a', 'member_b')).toBe(conversationKey('member_b', 'user_a'));
  });

  it('parses admin and member keys and rejects anything else', () => {
    expect(parseParticipantKey('user_x')).toEqual({ role: 'user', id: 'x' });
    expect(parseParticipantKey('member_y')).toEqual({ role: 'member', id: 'y' });
    expect(parseParticipantKey('admin_z')).toBeNull();
    expect(parseParticipantKey('user_')).toBeNull();
    expect(parseParticipantKey(undefined)).toBeNull();
  });
});

describe('sendDirectMessage', () => {
  it('rejects empty and over-long messages before touching the database', async () => {
    await expect(sendDirectMessage('g1', sender, 'member_b', '   ')).rejects.toThrow('empty');
    await expect(sendDirectMessage('g1', sender, 'member_b', 'x'.repeat(MAX_MESSAGE_LENGTH + 1))).rejects.toThrow('too long');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects messaging yourself', async () => {
    await expect(sendDirectMessage('g1', sender, 'user_a', 'hi')).rejects.toThrow('yourself');
  });

  it('rejects a recipient outside the caller group', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(sendDirectMessage('g1', sender, 'member_b', 'hi')).rejects.toThrow('not in your group');
    expect(pool.query.mock.calls[0][1]).toEqual(['b', 'g1']);
  });

  it('checks admin recipients against the groups table', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(sendDirectMessage('g1', sender, 'user_c', 'hi')).rejects.toThrow('not in your group');
    expect(pool.query.mock.calls[0][0]).toContain('FROM groups');
  });

  it('stores a trimmed message and pings both sides without content', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [row()] });

    const msg = await sendDirectMessage('g1', sender, 'member_b', '  hi  ');

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO direct_messages');
    expect(params).toEqual(['g1', conversationKey('user_a', 'member_b'), 'user_a', 'member_b', 'Eugene', 'hi']);
    expect(msg).toMatchObject({ id: 'm1', text: 'hi', createdAt: '1000', readAt: null });
    expect(mockDb.ref.mock.calls.map((c) => c[0])).toEqual([
      'groups/g1/dmPings/member_b',
      'groups/g1/dmPings/user_a',
    ]);
    expect(mockRef.set).toHaveBeenCalledWith('TIMESTAMP_PLACEHOLDER');
  });

  it('still returns the message when the ping fails', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [row()] });
    mockRef.set.mockRejectedValueOnce(new Error('rtdb down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendDirectMessage('g1', sender, 'member_b', 'hi')).resolves.toMatchObject({ id: 'm1' });
    spy.mockRestore();
  });
});

describe('listDirectMessages', () => {
  it('reads only the caller own conversation, oldest first', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row({ id: 'new', created_at: new Date(2000) }), row({ id: 'old' })] });
    const msgs = await listDirectMessages('g1', 'user_a', 'member_b');
    expect(pool.query.mock.calls[0][1].slice(0, 2)).toEqual(['g1', conversationKey('user_a', 'member_b')]);
    expect(msgs.map((m) => m.id)).toEqual(['old', 'new']);
  });

  it('clamps the page size and rejects bad cursors and keys', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await listDirectMessages('g1', 'user_a', 'member_b', { limit: 10_000 });
    expect(pool.query.mock.calls[0][1][3]).toBe(200);
    await expect(listDirectMessages('g1', 'user_a', 'member_b', { before: 'nope' })).rejects.toThrow('cursor');
    await expect(listDirectMessages('g1', 'user_a', 'bogus')).rejects.toThrow('Unknown conversation');
  });
});

describe('listDirectConversations', () => {
  it('pairs each thread with the other participant and their unread count', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          row({ id: 'x', sender_key: 'member_b', recipient_key: 'user_a', created_at: new Date(1000) }),
          row({ id: 'y', sender_key: 'user_a', recipient_key: 'user_c', created_at: new Date(5000) }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ sender_key: 'member_b', count: 3 }] });

    const convos = await listDirectConversations('g1', 'user_a');
    expect(convos.map((c) => [c.otherKey, c.unreadCount])).toEqual([
      ['user_c', 0],
      ['member_b', 3],
    ]);
  });
});

describe('listChatContacts', () => {
  it('lists admins and members in the group, excluding the caller', async () => {
    getGroupUsers.mockResolvedValueOnce([
      { id: 'a', name: 'Eugene', email: 'e@x.com' },
      { id: 'c', name: null, email: 'c@x.com' },
    ]);
    pool.query.mockResolvedValueOnce({ rows: [{ uuid: 'b', username: 'mel' }] });

    const contacts = await listChatContacts('g1', 'user_a');
    expect(contacts.map((c) => [c.key, c.name, c.role])).toEqual([
      ['user_c', 'c@x.com', 'user'],
      ['member_b', 'mel', 'member'],
    ]);
  });
});

describe('markDirectConversationRead', () => {
  it('only marks messages the other person sent to the caller', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 2 });
    await markDirectConversationRead('g1', 'user_a', 'member_b');
    expect(pool.query.mock.calls[0][1]).toEqual(['g1', 'user_a', 'member_b']);
    expect(mockDb.ref).toHaveBeenCalledWith('groups/g1/dmPings/user_a');
  });

  it('skips the ping when nothing changed', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    await markDirectConversationRead('g1', 'user_a', 'member_b');
    expect(mockDb.ref).not.toHaveBeenCalled();
  });
});

describe('resolveChatIdentity', () => {
  it('derives admin identity from the session', () => {
    expect(
      resolveChatIdentity({ user: { id: 'a', email: 'e@x.com', user_metadata: { name: 'Eugene' } }, groupId: 'g1' }),
    ).toEqual({ key: 'user_a', name: 'Eugene', groupId: 'g1' });
  });

  it('derives member identity from the session', () => {
    expect(resolveChatIdentity({ member: { uuid: 'b', username: 'mel', group_id: 'g1' } })).toEqual({
      key: 'member_b',
      name: 'mel',
      groupId: 'g1',
    });
  });

  it('rejects anonymous callers and admins without a group', () => {
    expect(() => resolveChatIdentity({})).toThrow('signed in');
    expect(() => resolveChatIdentity({ user: { id: 'a' }, groupId: null })).toThrow('group');
  });
});
