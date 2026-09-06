import {
    getFieldDefinitions,
    addFieldDefinition,
    updateFieldDefinition,
    deleteFieldDefinition,
} from '../models/customFields.js';
import { requireGroup } from '../utils/requireUser.js';

const customFieldResolvers = {
    Query: {
        customFieldDefinitions: async (_, { entityType }, context) => {
            const groupId = requireGroup(context);
            return getFieldDefinitions(entityType, groupId);
        },
    },
    Mutation: {
        addCustomFieldDefinition: async (_, { entityType, name, type, options }, context) => {
            const groupId = requireGroup(context);
            return addFieldDefinition({ entityType, name, type, options }, groupId);
        },
        updateCustomFieldDefinition: async (_, { fieldId, name, options }, context) => {
            const groupId = requireGroup(context);
            return updateFieldDefinition(fieldId, { name, options }, groupId);
        },
        deleteCustomFieldDefinition: async (_, { fieldId }, context) => {
            const groupId = requireGroup(context);
            return deleteFieldDefinition(fieldId, groupId);
        },
    },
};

export default customFieldResolvers;
