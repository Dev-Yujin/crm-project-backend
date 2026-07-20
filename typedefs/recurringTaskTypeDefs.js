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
    priority: TaskPriority!
    recurrence: Recurrence!
    createdBy: ID
    active: Boolean!
    lastRunAt: String
    nextRunAt: String
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
    ): RecurringTask!
    deleteRecurringTask(recurringTaskId: ID!): Boolean!
    pauseRecurringTask(recurringTaskId: ID!): RecurringTask!
    resumeRecurringTask(recurringTaskId: ID!): RecurringTask!
  }
`;

export default recurringTaskTypeDefs;
