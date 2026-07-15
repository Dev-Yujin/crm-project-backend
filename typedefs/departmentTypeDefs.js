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
    createdAt: String
    members: [DepartmentMember!]!
  }

  type Query {
    departments: [Department!]!
  }

  type Mutation {
    addDepartment(name: String!): Department!
    addMemberToDepartment(departmentId: ID!, memberUuid: ID!): DepartmentMember!
    removeMemberFromDepartment(departmentId: ID!, memberUuid: ID!): Boolean!
  }
`;

export default departmentTypeDefs;
