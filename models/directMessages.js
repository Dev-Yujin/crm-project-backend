import { GraphQLError } from 'graphql';
import { getDatabase, ServerValue } from 'firebase-admin/database';
import { app } from '../config/firebase.js';
import { pool } from '../config/supabase.js';
import { getGroupUsers } from './groups.js';

const db = getDatabase(app);

export const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

// Participants are addressed by the same keys the frontend already uses for
// notifications: `user_<supabaseId>` for admins, `member_<uuid>` for members.
// Two identity spaces, one namespace.
export const userKey = (id) => `user_${id}`;
export const memberKey = (uuid) => `member_${uuid}`;

export function parseParticipantKey(key) {
    if (typeof key !== 'string') return null;
    if (key.startsWith('user_') && key.length > 5) return { role: 'user', id: key.slice(5) };
    if (key.startsWith('member_') && key.length > 7) return { role: 'member', id: key.slice(7) };
    return null;
}

// Order-independent, so A→B and B→A land in the same thread.
export function conversationKey(a, b) {
    return [a, b].sort().join('|');
}

const badInput = (message) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

function mapMessage(row) {
    return {
        id: row.id,
        senderKey: row.sender_key,
        recipientKey: row.recipient_key,
        senderName: row.sender_name,
        text: row.body,
        createdAt: row.created_at ? String(new Date(row.created_at).getTime()) : null,
        readAt: row.read_at ? String(new Date(row.read_at).getTime()) : null,
    };
}

// Everyone the caller can message: every admin and every member in their group,
// minus themselves. Callable by both actor types — members can't read the
// admin-only `members` / `groupUsers` queries, and they need this roster too.
export async function listChatContacts(groupId, selfKey) {
    const [admins, members] = await Promise.all([
        getGroupUsers(groupId),
        pool.query('SELECT uuid, username, avatar_base64 FROM members WHERE group_id = $1 ORDER BY username', [groupId]),
    ]);

    const contacts = [
        ...admins.map((u) => ({
            key: userKey(u.id),
            name: u.name?.trim() || u.email?.trim() || 'Admin',
            role: 'user',
            avatarBase64: u.avatar_base64 ?? null,
        })),
        ...members.rows.map((m) => ({
            key: memberKey(m.uuid),
            name: m.username,
            role: 'member',
            avatarBase64: m.avatar_base64 ?? null,
        })),
    ];
    return contacts.filter((c) => c.key !== selfKey);
}

// Throws unless `key` names an admin or member who belongs to `groupId` right now.
// This is the line that stops anyone messaging (or reading a thread with) someone
// outside their own group.
export async function assertParticipantInGroup(key, groupId) {
    const parsed = parseParticipantKey(key);
    if (!parsed) throw badInput('Unknown recipient.');

    const result = parsed.role === 'user'
        ? await pool.query('SELECT 1 FROM groups WHERE "userId" = $1 AND "groupId" = $2 LIMIT 1', [parsed.id, groupId])
        : await pool.query('SELECT 1 FROM members WHERE uuid = $1 AND group_id = $2 LIMIT 1', [parsed.id, groupId]);

    if (result.rows.length === 0) throw badInput('That person is not in your group.');
}

// Content-free nudge so open chat screens refetch over GraphQL. RTDB is
// world-readable, so only a timestamp goes there — never text or sender.
// Best-effort: the message is already saved, a missed ping just means the
// other side sees it on their next refresh.
async function ping(groupId, keys) {
    try {
        await Promise.all(keys.map((key) => db.ref(`groups/${groupId}/dmPings/${key}`).set(ServerValue.TIMESTAMP)));
    } catch (err) {
        console.error('Failed to send DM ping:', err);
    }
}

export async function sendDirectMessage(groupId, sender, recipientKey, text) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw badInput('Message cannot be empty.');
    if (body.length > MAX_MESSAGE_LENGTH) throw badInput(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
    if (recipientKey === sender.key) throw badInput("You can't message yourself.");

    await assertParticipantInGroup(recipientKey, groupId);

    const result = await pool.query(
        `INSERT INTO direct_messages (group_id, conversation_key, sender_key, recipient_key, sender_name, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, sender_key, recipient_key, sender_name, body, created_at, read_at`,
        [groupId, conversationKey(sender.key, recipientKey), sender.key, recipientKey, sender.name, body],
    );

    // The sender is pinged too, so their other open tabs pick the message up.
    await ping(groupId, [recipientKey, sender.key]);
    return mapMessage(result.rows[0]);
}

// One thread, oldest→newest. `before` (epoch ms string) pages back through history.
// Only ever reads the caller's own conversation — the key is built from selfKey,
// which comes from the session, never from the client.
export async function listDirectMessages(groupId, selfKey, otherKey, { before = null, limit = DEFAULT_PAGE } = {}) {
    if (!parseParticipantKey(otherKey)) throw badInput('Unknown conversation.');
    const pageSize = Math.min(Math.max(Number(limit) || DEFAULT_PAGE, 1), MAX_PAGE);
    const beforeMs = before === null || before === undefined ? null : Number(before);
    if (beforeMs !== null && !Number.isFinite(beforeMs)) throw badInput('Invalid cursor.');

    const result = await pool.query(
        `SELECT id, sender_key, recipient_key, sender_name, body, created_at, read_at
         FROM direct_messages
         WHERE group_id = $1 AND conversation_key = $2
           AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
         ORDER BY created_at DESC
         LIMIT $4`,
        [groupId, conversationKey(selfKey, otherKey), beforeMs === null ? null : new Date(beforeMs).toISOString(), pageSize],
    );
    return result.rows.reverse().map(mapMessage);
}

// The caller's inbox: latest message + unread count per conversation, newest first.
export async function listDirectConversations(groupId, selfKey) {
    const [latest, unread] = await Promise.all([
        pool.query(
            `SELECT DISTINCT ON (conversation_key)
                    id, sender_key, recipient_key, sender_name, body, created_at, read_at
             FROM direct_messages
             WHERE group_id = $1 AND (sender_key = $2 OR recipient_key = $2)
             ORDER BY conversation_key, created_at DESC`,
            [groupId, selfKey],
        ),
        pool.query(
            `SELECT sender_key, COUNT(*)::int AS count
             FROM direct_messages
             WHERE group_id = $1 AND recipient_key = $2 AND read_at IS NULL
             GROUP BY sender_key`,
            [groupId, selfKey],
        ),
    ]);

    const unreadBySender = new Map(unread.rows.map((r) => [r.sender_key, r.count]));
    return latest.rows
        .map((row) => {
            const otherKey = row.sender_key === selfKey ? row.recipient_key : row.sender_key;
            return { otherKey, lastMessage: mapMessage(row), unreadCount: unreadBySender.get(otherKey) ?? 0 };
        })
        .sort((a, b) => Number(b.lastMessage.createdAt) - Number(a.lastMessage.createdAt));
}

export async function markDirectConversationRead(groupId, selfKey, otherKey) {
    if (!parseParticipantKey(otherKey)) throw badInput('Unknown conversation.');
    const result = await pool.query(
        `UPDATE direct_messages SET read_at = now()
         WHERE group_id = $1 AND recipient_key = $2 AND sender_key = $3 AND read_at IS NULL`,
        [groupId, selfKey, otherKey],
    );
    // Other open tabs of the reader should drop their unread badge too.
    if (result.rowCount > 0) await ping(groupId, [selfKey]);
    return true;
}
