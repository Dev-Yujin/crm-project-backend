const jobTypeDefs = `#graphql
  type JobMember {
    uuid: ID!
    username: String!
    email: String!
    assignedAt: String
  }

  type Job {
    id: ID!
    title: String!
    createdAt: String
    members: [JobMember!]!
  }

  type Query {
    jobs: [Job!]!
  }

  type Mutation {
    addJob(title: String!): Job!
    addMemberToJob(jobId: ID!, memberUuid: ID!): JobMember!
    removeMemberFromJob(jobId: ID!, memberUuid: ID!): Boolean!
  }
`;

export default jobTypeDefs;
