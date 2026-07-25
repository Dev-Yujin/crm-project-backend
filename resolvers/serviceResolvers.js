import {
    getAllServices,
    addService,
    updateService,
    deleteService,
} from '../models/services.js';
import { requireGroup, resolveGroupId } from '../utils/requireUser.js';

const serviceResolvers = {
    Query: {
        services: async (_, { groupId }, context) => {
            return getAllServices(resolveGroupId(context, groupId));
        },
    },
    Mutation: {
        addService: async (_, { name }, context) => {
            const groupId = requireGroup(context);
            return addService(name, groupId);
        },
        updateService: async (_, { serviceId, name }, context) => {
            const groupId = requireGroup(context);
            return updateService(serviceId, name, groupId);
        },
        deleteService: async (_, { serviceId }, context) => {
            const groupId = requireGroup(context);
            return deleteService(serviceId, groupId);
        },
    },
};

export default serviceResolvers;
