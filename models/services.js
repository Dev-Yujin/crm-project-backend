import { getDatabase, ref, push, set, get, remove, update } from "firebase/database";
import { app } from "../config/firebase.js";
//The catalog of services the business offers (e.g. "Web Development", "Video Editing") — scoped per group

const db = getDatabase(app);

//Fetch all services belonging to a group
export const getAllServices = async (groupId) => {
    try {
        const servicesSnapshot = await get(ref(db, "services"));
        const servicesData = servicesSnapshot.val();
        const services = servicesData ? Object.entries(servicesData).map(([id, service]) => ({ id, ...service })) : [];
        return services.filter((service) => service.groupId === groupId);
    } catch (error) {
        console.error("Error fetching services:", error);
        throw error;
    }
};

//Add a new service to a group's catalog
export const addService = async (name, groupId) => {
    try {
        const servicesRef = ref(db, "services");
        const newServiceRef = push(servicesRef);
        await set(newServiceRef, { name, groupId });
        return { id: newServiceRef.key, name, groupId };
    } catch (error) {
        console.error("Error adding service:", error);
        throw error;
    }
};

//Update a service's name (must belong to the caller's group)
export const updateService = async (serviceId, name, groupId) => {
    try {
        const serviceRef = ref(db, `services/${serviceId}`);
        const serviceSnapshot = await get(serviceRef);

        if (!serviceSnapshot.exists() || serviceSnapshot.val().groupId !== groupId) {
            throw new Error("Service not found");
        }

        await update(serviceRef, { name });
        return { id: serviceId, name, groupId };
    } catch (error) {
        console.error("Error updating service:", error);
        throw error;
    }
};

//Delete a service (must belong to the caller's group)
export const deleteService = async (serviceId, groupId) => {
    try {
        const serviceRef = ref(db, `services/${serviceId}`);
        const serviceSnapshot = await get(serviceRef);

        if (!serviceSnapshot.exists() || serviceSnapshot.val().groupId !== groupId) {
            throw new Error("Service not found");
        }

        await remove(serviceRef);
        return { id: serviceId, ...serviceSnapshot.val() };
    } catch (error) {
        console.error("Error deleting service:", error);
        throw error;
    }
};

//Validate that every given service ID exists in the given group's catalog
export const validateServicesExist = async (serviceIds, groupId) => {
    if (!serviceIds || serviceIds.length === 0) {
        return;
    }

    const services = await getAllServices(groupId);
    const existingIds = new Set(services.map((service) => service.id));
    const missing = serviceIds.filter((id) => !existingIds.has(id));

    if (missing.length > 0) {
        throw new Error(`Service(s) not found: ${missing.join(", ")}`);
    }
};
