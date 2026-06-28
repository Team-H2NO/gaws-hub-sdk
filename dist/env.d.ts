export declare const env: {
    /** Hub API root (service plane + lifecycle). */
    hubUrl: string;
    /** Hub bus root (`…/bus`); empty unless messaging/store granted. */
    busUrl: string;
    /** Hub store root; empty unless `store` granted. */
    storeUrl: string;
    /** Per-instance bearer token for bus/store + job reports. */
    busToken: string;
    /** This instance's id (also its network alias). */
    instance: string;
    /** This agent type's name. */
    agentName: string;
    /** Port to serve on. */
    port: number;
};
