const userTypeDefs = `#graphql
  type Query {
    currentUser(accessToken: String!): User
  }

  type Mutation {
    registerUser(name: String!, email: String!, password: String!): AuthPayload!
    loginUser(email: String!, password: String!): AuthPayload!
    signInWithGoogle(redirectTo: String): OAuthPayload!
    signOutUser: Boolean!
  }

  type User {
    id: ID!
    email: String
    name: String
  }

  type AuthSession {
    accessToken: String
    refreshToken: String
    expiresAt: Int
  }

  type AuthPayload {
    user: User
    session: AuthSession
  }

  type OAuthPayload {
    url: String!
    provider: String!
  }
`;

export default userTypeDefs;
