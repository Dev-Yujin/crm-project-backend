import {
    getAllTaskStatuses,
    addTaskStatus,
    updateTaskStatus,
    deleteTaskStatus,
} from '../models/taskStatuses.js';
import { requireUser } from '../utils/requireUser.js';

const taskStatusResolvers = {
    Query: {
        taskStatuses: async () => {
            return getAllTaskStatuses();
        },
    },
    Mutation: {
        addTaskStatus: async (_, { name }, context) => {
            requireUser(context);
            return addTaskStatus(name);
        },
        updateTaskStatus: async (_, { taskStatusId, name }, context) => {
            requireUser(context);
            return updateTaskStatus(taskStatusId, name);
        },
        deleteTaskStatus: async (_, { taskStatusId }, context) => {
            requireUser(context);
            return deleteTaskStatus(taskStatusId);
        },
    },
};

export default taskStatusResolvers;
