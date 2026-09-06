const customFieldTypeDefs = `#graphql
  enum CustomFieldEntityType {
    TASK
    CLIENT
    RECURRING_TASK
  }

  enum CustomFieldType {
    TEXT
    NUMBER
    DATE
    DROPDOWN
  }

  type CustomFieldDefinition {
    id: ID!
    entityType: CustomFieldEntityType!
    name: String!
    type: CustomFieldType!
    options: [String!]
    groupId: ID!
  }

  type CustomFieldValue {
    fieldId: ID!
    value: String!
  }

  input CustomFieldValueInput {
    fieldId: ID!
    value: String!
  }

  type Query {
    customFieldDefinitions(entityType: CustomFieldEntityType!): [CustomFieldDefinition!]!
  }

  type Mutation {
    addCustomFieldDefinition(entityType: CustomFieldEntityType!, name: String!, type: CustomFieldType!, options: [String!]): CustomFieldDefinition!
    "type is deliberately not editable — delete and recreate the field to change it."
    updateCustomFieldDefinition(fieldId: ID!, name: String, options: [String!]): CustomFieldDefinition!
    "Never touches stored values on any Task/Client/RecurringTask record — they become inert, not deleted."
    deleteCustomFieldDefinition(fieldId: ID!): Boolean!
  }
`;

export default customFieldTypeDefs;
