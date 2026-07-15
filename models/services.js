import { getDatabase, ref, push, set, get, remove, update } from "firebase/database";
import { app } from "../config/firebase.js";
//The catalog of services the business offers (e.g. "Web Development", "Video Editing")

const db = getDatabase(app);

//Fetch all services
export const getAllServices = async () => {
    try {
        const servicesSnapshot = await get(ref(db, "services"));
        const servicesData = servicesSnapshot.val();
        return servicesData ? Object.entries(servicesData).map(([id, service]) => ({ id, ...service })) : [];
    } catch (error) {
        console.error("Error fetching services:", error);
        throw error;
    }
};

//Add a new service
export const addService = async (name) => {
    try {
        const servicesRef = ref(db, "services");
        const newServiceRef = push(servicesRef);
        await set(newServiceRef, { name });
        return { id: newServiceRef.key, name };
    } catch (error) {
        console.error("Error adding service:", error);
        throw error;
    }
};

//Update a service's name
export const updateService = async (serviceId, name) => {
    try {
        const serviceRef = ref(db, `services/${serviceId}`);
        const serviceSnapshot = await get(serviceRef);

        if (!serviceSnapshot.exists()) {
            throw new Error("Service not found");
        }

        await update(serviceRef, { name });
        return { id: serviceId, name };
    } catch (error) {
        console.error("Error updating service:", error);
        throw error;
    }
};

//Delete a service
export const deleteService = async (serviceId) => {
    try {
        const serviceRef = ref(db, `services/${serviceId}`);
        const serviceSnapshot = await get(serviceRef);

        if (!serviceSnapshot.exists()) {
            throw new Error("Service not found");
        }

        await remove(serviceRef);
        return { id: serviceId, ...serviceSnapshot.val() };
    } catch (error) {
        console.error("Error deleting service:", error);
        throw error;
    }
};

//Validate that every given service ID exists in the catalog
export const validateServicesExist = async (serviceIds) => {
    if (!serviceIds || serviceIds.length === 0) {
        return;
    }

    const services = await getAllServices();
    const existingIds = new Set(services.map((service) => service.id));
    const missing = serviceIds.filter((id) => !existingIds.has(id));

    if (missing.length > 0) {
        throw new Error(`Service(s) not found: ${missing.join(", ")}`);
    }
};
