import {
    addDepartment,
    updateDepartment,
    deleteDepartment,
    addMemberToDepartment,
    getAllDepartments,
    removeMemberFromDepartment,
} from '../models/departments.js';
import { requireGroup, resolveGroupId } from '../utils/requireUser.js';

const mapDepartment = (department) => ({
    id: department.id,
    name: department.name,
    groupId: department.groupId,
    createdAt: department.createdAt != null ? String(department.createdAt) : null,
    members: (department.members ?? []).map(mapDepartmentMember),
});

const mapDepartmentMember = (member) => ({
    uuid: member.uuid,
    username: member.username,
    email: member.email,
    assignedAt: member.assignedAt != null ? String(member.assignedAt) : null,
});

const departmentResolvers = {
    Query: {
        departments: async (_, { groupId }, context) => {
            const departments = await getAllDepartments(resolveGroupId(context, groupId));
            return departments.map(mapDepartment);
        },
    },
    Mutation: {
        addDepartment: async (_, { name }, context) => {
            const groupId = requireGroup(context);
            const department = await addDepartment(name, groupId);
            return mapDepartment(department);
        },
        updateDepartment: async (_, { departmentId, name }, context) => {
            const groupId = requireGroup(context);
            const department = await updateDepartment(departmentId, name, groupId);
            return mapDepartment(department);
        },
        deleteDepartment: async (_, { departmentId }, context) => {
            const groupId = requireGroup(context);
            const department = await deleteDepartment(departmentId, groupId);
            return mapDepartment(department);
        },
        addMemberToDepartment: async (_, { departmentId, memberUuid }, context) => {
            const groupId = requireGroup(context);
            const member = await addMemberToDepartment(departmentId, memberUuid, groupId);
            return mapDepartmentMember(member);
        },
        removeMemberFromDepartment: async (_, { departmentId, memberUuid }, context) => {
            const groupId = requireGroup(context);
            return removeMemberFromDepartment(departmentId, memberUuid, groupId);
        },
    },
};

export default departmentResolvers;
