const groupTypeDefs = `#graphql
  type Group {
    groupId: ID!
    joinCode: String!
  }

  type Query {
    myGroup: Group
  }

  type Mutation {
    joinGroup(joinCode: String!): Group!
  }
`;

export default groupTypeDefs;
