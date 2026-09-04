const memberTypeDefs = `#graphql
  type Member {
    uuid: ID!
    username: String!
    email: String!
    groupId: ID
    createdAt: String
    inviteSent: Boolean
    inviteError: String
    avatarBase64: String
  }

  "token is set as an httpOnly cookie (see MEMBER_SECURITY_INTEGRATION.md) — never returned here"
  type MemberAuthPayload {
    member: Member!
  }

  type Query {
    members: [Member!]!
    "Prefers the Authorization header; token arg is a fallback for un-migrated callers."
    currentMember(token: String): Member
  }

  type Mutation {
    addMember(username: String!, email: String!, password: String!, sendInvite: Boolean): Member!
    deleteMember(uuid: ID!, reassignTo: ID): Member!
    "For a user (admin): uuid is required, edits a member in the caller's own group. For a member: uuid is ignored, always edits the caller's own profile. avatarBase64: null explicitly removes the photo; omit it to leave the photo untouched."
    editMemberProfile(uuid: ID, username: String, email: String, password: String, avatarBase64: String): Member!
    loginMember(email: String!, password: String!): MemberAuthPayload!
    "Clears the member auth cookie server-side."
    logoutMember: Boolean!
    "Admin (user) action: invalidates every outstanding token this member holds."
    revokeMemberSessions(uuid: ID!): Boolean!
  }
`;

export default memberTypeDefs;
