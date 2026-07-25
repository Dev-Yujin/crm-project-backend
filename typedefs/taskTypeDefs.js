const taskTypeDefs = `#graphql
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
    statusId: ID
    departmentId: ID
    groupId: ID!
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
      statusId: ID
      departmentId: ID
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
      statusId: ID
      departmentId: ID
    ): Task!
    deleteTask(taskId: ID!): Task!
    submitTask(taskId: ID!, memberUuid: ID!, link: String!, note: String): Task!
    reviewTask(taskId: ID!, comment: String!): Task!
  }
`;

export default taskTypeDefs;
