const emailCredentialsTypeDefs = `#graphql
  type EmailCredentials {
    email: String!
    updatedAt: String!
  }

  type Query {
    myEmailCredentials: EmailCredentials
  }

  type Mutation {
    updateEmailCredentials(email: String!, appPassword: String!): EmailCredentials!
  }
`;

export default emailCredentialsTypeDefs;
