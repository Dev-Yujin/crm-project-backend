const taskTypeDefs = `#graphql
  enum TaskStatus {
    PENDING
    IN_PROGRESS
    SUBMITTED
    FOR_REVISION
    COMPLETED
  }

  enum ReviewDecision {
    FOR_REVISION
    COMPLETED
  }

  enum TaskPriority {
    LOW
    MEDIUM
    HIGH
    URGENT
  }

  type Submission {
    link: String!
    note: String
    submittedBy: ID!
    submittedAt: String
  }

  type Revision {
    id: ID!
    comment: String!
    status: TaskStatus!
    reviewedBy: ID!
    reviewedAt: String
  }

  type Task {
    id: ID!
    clientId: ID!
    clientName: String!
    taskName: String!
    taskDescription: String!
    serviceId: ID!
    assignedMembers: [ID!]!
    dueDate: String
    createdBy: ID
    priority: TaskPriority!
    status: TaskStatus!
    createdAt: String
    submission: Submission
    revisions: [Revision!]!
    recurringTaskId: ID
  }

  type Query {
    tasks: [Task!]!
    tasksForMember(memberUuid: ID!): [Task!]!
  }

  type Mutation {
    addTask(
      clientId: ID!
      clientName: String!
      taskName: String!
      taskDescription: String!
      serviceId: ID!
      assignedMembers: [ID!]!
      dueDate: String
      priority: TaskPriority
    ): Task!
    editTask(
      taskId: ID!
      clientId: ID
      clientName: String
      taskName: String
      taskDescription: String
      serviceId: ID
      assignedMembers: [ID!]
      dueDate: String
      priority: TaskPriority
    ): Task!
    deleteTask(taskId: ID!): Task!
    startTask(taskId: ID!, memberUuid: ID!): Task!
    submitTask(taskId: ID!, memberUuid: ID!, link: String!, note: String): Task!
    reviewTask(taskId: ID!, comment: String!, decision: ReviewDecision!): Task!
  }
`;

export default taskTypeDefs;
