const directMessageTypeDefs = `#graphql
  "Someone the caller can message privately. key is user_<id> for admins, member_<uuid> for members."
  type ChatContact {
    key: ID!
    name: String!
    "user (admin) or member"
    role: String!
    avatarBase64: String
  }

  type DirectMessage {
    id: ID!
    senderKey: ID!
    recipientKey: ID!
    senderName: String!
    text: String!
    "Epoch milliseconds, as a string"
    createdAt: String
    readAt: String
  }

  type DirectConversation {
    otherKey: ID!
    lastMessage: DirectMessage!
    unreadCount: Int!
  }

  type Query {
    "Everyone in the caller's group they can message. Admins and members."
    chatContacts: [ChatContact!]!
    "The caller's private conversations, newest first."
    directConversations: [DirectConversation!]!
    "One private thread with withKey, oldest first. before (epoch ms) pages back."
    directMessages(withKey: ID!, before: String, limit: Int): [DirectMessage!]!
  }

  type Mutation {
    sendDirectMessage(toKey: ID!, text: String!): DirectMessage!
    "Marks every message withKey sent the caller as read."
    markDirectConversationRead(withKey: ID!): Boolean!
  }
`;

export default directMessageTypeDefs;
