import {
    getAllServices,
    addService,
    updateService,
    deleteService,
} from '../models/services.js';
import { requireUser } from '../utils/requireUser.js';

const serviceResolvers = {
    Query: {
        services: async () => {
            return getAllServices();
        },
    },
    Mutation: {
        addService: async (_, { name }, context) => {
            requireUser(context);
            return addService(name);
        },
        updateService: async (_, { serviceId, name }, context) => {
            requireUser(context);
            return updateService(serviceId, name);
        },
        deleteService: async (_, { serviceId }, context) => {
            requireUser(context);
            return deleteService(serviceId);
        },
    },
};

export default serviceResolvers;
