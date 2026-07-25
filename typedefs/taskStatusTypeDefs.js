const taskStatusTypeDefs = `#graphql
  type TaskStatus {
    id: ID!
    name: String!
    groupId: ID!
  }

  type Query {
    taskStatuses(groupId: ID): [TaskStatus!]!
  }

  type Mutation {
    addTaskStatus(name: String!): TaskStatus!
    updateTaskStatus(taskStatusId: ID!, name: String!): TaskStatus!
    deleteTaskStatus(taskStatusId: ID!): TaskStatus!
  }
`;

export default taskStatusTypeDefs;
