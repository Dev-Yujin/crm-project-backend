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

  type TaskAttachment {
    filename: String!
    contentType: String!
    sizeBytes: Int!
    uploadedBy: ID!
    uploadedAt: String!
  }

  type UploadTarget {
    uploadUrl: String!
    key: String!
  }

  type Task {
    id: ID!
    clientId: ID!
    clientName: String!
    taskName: String!
    taskDescription: String!
    serviceId: ID!
    assignedMembers: [ID!]!
    assignedUsers: [ID!]!
    dueDate: String
    createdBy: ID
    priority: TaskPriority!
    statusId: ID
    departmentId: ID
    groupId: ID!
    liveLink: String
    source: String
    notes: String
    attachment: TaskAttachment
    createdAt: String
    submission: Submission
    revisions: [Revision!]!
    recurringTaskId: ID
  }

  type Query {
    tasks: [Task!]!
    "Requires a member bearer token. memberUuid arg is accepted for backward compatibility but ignored — identity always comes from the token."
    tasksForMember(memberUuid: ID): [Task!]!
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
      liveLink: String
      source: String
      notes: String
      assignedUsers: [ID!]
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
      liveLink: String
      source: String
      notes: String
      assignedUsers: [ID!]
    ): Task!
    deleteTask(taskId: ID!): Task!
    "For a user (admin): memberUuid is required — who the submission is on behalf of. For a member: memberUuid is ignored, always the caller."
    submitTask(taskId: ID!, memberUuid: ID, link: String!, note: String): Task!
    reviewTask(taskId: ID!, comment: String!): Task!
    requestTaskUploadUrl(taskId: ID!, filename: String!, contentType: String!, sizeBytes: Int!): UploadTarget!
    confirmTaskAttachment(taskId: ID!, key: String!, filename: String!, contentType: String!, sizeBytes: Int!): Task!
  }
`;

export default taskTypeDefs;
