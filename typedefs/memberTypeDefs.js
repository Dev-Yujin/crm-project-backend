const memberTypeDefs = `#graphql
  type Member {
    uuid: ID!
    username: String!
    email: String!
    createdAt: String
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
    addMember(username: String!, email: String!, password: String!): Member!
    deleteMember(uuid: ID!): Member!
    editMemberProfile(uuid: ID!, username: String, email: String, password: String): Member!
    loginMember(email: String!, password: String!): MemberAuthPayload!
  }
`;

export default memberTypeDefs;
