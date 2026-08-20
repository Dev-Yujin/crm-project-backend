const userTypeDefs = `#graphql
  type Query {
    "Cookie-based — resolves the caller's own Supabase session. accessToken arg is a fallback for non-browser callers (scripts, tests); the browser app never needs to pass it."
    currentUser(accessToken: String): User
  }

  type Mutation {
    registerUser(name: String!, email: String!, password: String!): AuthPayload!
    loginUser(email: String!, password: String!): AuthPayload!
    signOutUser: Boolean!
  }

  type User {
    id: ID!
    email: String
    name: String
  }

  "No session field — the session is set as an httpOnly cookie on the response instead. See ADMIN_SESSION_SECURITY_INTEGRATION.md. Google sign-in is a plain redirect to GET /auth/google on the API host, not a mutation."
  type AuthPayload {
    user: User
  }
`;

export default userTypeDefs;
