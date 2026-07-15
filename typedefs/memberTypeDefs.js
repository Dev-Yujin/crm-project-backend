const memberTypeDefs = `#graphql
  type Member {
    uuid: ID!
    username: String!
    email: String!
    createdAt: String
  }

  type Mutation {
    addMember(username: String!, email: String!, password: String!): Member!
    deleteMember(uuid: ID!): Member!
    editMemberProfile(uuid: ID!, username: String, email: String, password: String): Member!
  }
`;

export default memberTypeDefs;
