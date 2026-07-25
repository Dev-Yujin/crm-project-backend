const departmentTypeDefs = `#graphql
  type DepartmentMember {
    uuid: ID!
    username: String!
    email: String!
    assignedAt: String
  }

  type Department {
    id: ID!
    name: String!
    groupId: ID!
    createdAt: String
    members: [DepartmentMember!]!
  }

  type Query {
    departments(groupId: ID): [Department!]!
  }

  type Mutation {
    addDepartment(name: String!): Department!
    addMemberToDepartment(departmentId: ID!, memberUuid: ID!): DepartmentMember!
    removeMemberFromDepartment(departmentId: ID!, memberUuid: ID!): Boolean!
  }
`;

export default departmentTypeDefs;
