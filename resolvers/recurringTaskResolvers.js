import {
    getAllRecurringTasks,
    addRecurringTask,
    editRecurringTask,
    deleteRecurringTask,
    pauseRecurringTask,
    resumeRecurringTask,
} from '../models/recurringTasks.js';
import { requireUser, requireGroup } from '../utils/requireUser.js';
import { fromStoredCustomFields } from '../models/customFields.js';

const mapRecurringTask = (template) => template && {
    id: template.id,
    clientId: template.clientId,
    clientName: template.clientName,
    taskName: template.taskName,
    taskDescription: template.taskDescription,
    serviceId: template.serviceId,
    assignedMembers: template.assignedMembers ?? [],
    assignedUsers: template.assignedUsers ?? [],
    priority: template.priority,
    recurrence: template.recurrence,
    createdBy: template.createdBy ?? null,
    active: template.active,
    lastRunAt: template.lastRunAt != null ? String(template.lastRunAt) : null,
    nextRunAt: template.nextRunAt != null ? String(template.nextRunAt) : null,
    departmentId: template.departmentId ?? null,
    groupId: template.groupId,
    customFields: fromStoredCustomFields(template.customFields),
};

const recurringTaskResolvers = {
    Query: {
        recurringTasks: async (_, __, context) => {
            const groupId = requireGroup(context);
            const templates = await getAllRecurringTasks(groupId);
            return templates.map(mapRecurringTask);
        },
    },
    Mutation: {
        addRecurringTask: async (_, { clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, recurrence, priority, assignedUsers, departmentId, customFields }, context) => {
            const user = requireUser(context);
            const groupId = requireGroup(context);
            const template = await addRecurringTask(clientId, clientName, taskName, taskDescription, serviceId, assignedMembers, user.id, recurrence, priority, groupId, assignedUsers, departmentId, customFields);
            return mapRecurringTask(template);
        },
        editRecurringTask: async (_, { recurringTaskId, ...updates }, context) => {
            const groupId = requireGroup(context);
            const template = await editRecurringTask(recurringTaskId, updates, groupId);
            return mapRecurringTask(template);
        },
        deleteRecurringTask: async (_, { recurringTaskId }, context) => {
            const groupId = requireGroup(context);
            return deleteRecurringTask(recurringTaskId, groupId);
        },
        pauseRecurringTask: async (_, { recurringTaskId }, context) => {
            const groupId = requireGroup(context);
            const template = await pauseRecurringTask(recurringTaskId, groupId);
            return mapRecurringTask(template);
        },
        resumeRecurringTask: async (_, { recurringTaskId }, context) => {
            const groupId = requireGroup(context);
            const template = await resumeRecurringTask(recurringTaskId, groupId);
            return mapRecurringTask(template);
        },
    },
};

export default recurringTaskResolvers;
