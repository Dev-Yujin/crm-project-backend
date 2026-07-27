const memberTypeDefs = `#graphql
  type Member {
    uuid: ID!
    username: String!
    email: String!
    groupId: ID
    createdAt: String
    inviteSent: Boolean
    inviteError: String
  }

  type MemberAuthPayload {
    member: Member!
    token: String!
  }

  type Query {
    members: [Member!]!
    currentMember(token: String!): Member
  }

  type Mutation {
    addMember(username: String!, email: String!, password: String!, sendInvite: Boolean): Member!
    deleteMember(uuid: ID!): Member!
    editMemberProfile(uuid: ID!, username: String, email: String, password: String): Member!
    loginMember(email: String!, password: String!): MemberAuthPayload!
  }
`;

export default memberTypeDefs;
