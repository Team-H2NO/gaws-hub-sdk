// Environment the hub injects (agents-interface §7). Never hardcode hostnames —
// read them here. `hub` is the hub's alias on every instance's private network.

export const env = {
  /** Hub API root (service plane + lifecycle). */
  hubUrl: process.env.HUB_URL || "http://hub:3000",
  /** Hub bus root (`…/bus`); empty unless messaging/store granted. */
  busUrl: process.env.BUS_URL || "",
  /** Hub store root; empty unless `store` granted. */
  storeUrl: process.env.STORE_URL || "",
  /** Per-instance bearer token for bus/store + job reports. */
  busToken: process.env.BUS_TOKEN || "",
  /** This instance's id (also its network alias). */
  instance: process.env.GAWS_HUB_INSTANCE || "local",
  /** This agent type's name. */
  agentName: process.env.AGENT_NAME || "agent",
  /** Port to serve on. */
  port: parseInt(process.env.PORT || "3000", 10),
};
