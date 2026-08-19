const recurringTaskTypeDefs = `#graphql
  enum Recurrence {
    DAILY
    WEEKLY
    MONTHLY
  }

  type RecurringTask {
    id: ID!
    clientId: ID!
    clientName: String!
    taskName: String!
    taskDescription: String!
    serviceId: ID!
    assignedMembers: [ID!]!
    assignedUsers: [ID!]!
    priority: TaskPriority!
    recurrence: Recurrence!
    createdBy: ID
    active: Boolean!
    lastRunAt: String
    nextRunAt: String
    groupId: ID!
  }

  type Query {
    recurringTasks: [RecurringTask!]!
  }

  type Mutation {
    addRecurringTask(
      clientId: ID!
      clientName: String!
      taskName: String!
      taskDescription: String!
      serviceId: ID!
      assignedMembers: [ID!]!
      recurrence: Recurrence!
      priority: TaskPriority
      assignedUsers: [ID!]
    ): RecurringTask!
    deleteRecurringTask(recurringTaskId: ID!): Boolean!
    pauseRecurringTask(recurringTaskId: ID!): RecurringTask!
    resumeRecurringTask(recurringTaskId: ID!): RecurringTask!
  }
`;

export default recurringTaskTypeDefs;
