const groupTypeDefs = `#graphql
  type Group {
    groupId: ID!
    joinCode: String!
  }

  type GroupUser {
    id: ID!
    email: String
    name: String
    createdAt: String
  }

  type Query {
    myGroup: Group
    groupUsers: [GroupUser!]!
  }

  type Mutation {
    joinGroup(joinCode: String!): Group!
  }
`;

export default groupTypeDefs;
