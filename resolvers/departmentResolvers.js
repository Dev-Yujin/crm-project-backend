import {
    addDepartment,
    addMemberToDepartment,
    getAllDepartments,
    removeMemberFromDepartment,
} from '../models/departments.js';
import { requireUser } from '../utils/requireUser.js';

const mapDepartment = (department) => ({
    id: department.id,
    name: department.name,
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
        departments: async () => {
            const departments = await getAllDepartments();
            return departments.map(mapDepartment);
        },
    },
    Mutation: {
        addDepartment: async (_, { name }, context) => {
            requireUser(context);
            const department = await addDepartment(name);
            return mapDepartment(department);
        },
        addMemberToDepartment: async (_, { departmentId, memberUuid }, context) => {
            requireUser(context);
            const member = await addMemberToDepartment(departmentId, memberUuid);
            return mapDepartmentMember(member);
        },
        removeMemberFromDepartment: async (_, { departmentId, memberUuid }, context) => {
            requireUser(context);
            return removeMemberFromDepartment(departmentId, memberUuid);
        },
    },
};

export default departmentResolvers;
