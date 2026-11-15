export type RemoteAgent = { id: string; name: string; capabilities: string[] };

export const RemoteAgentRegistry = {
  agents: [] as RemoteAgent[],
  register(agent: RemoteAgent) {
    this.agents.push(agent);
  },
  find(capability: string) {
    return this.agents.find((agent) => agent.capabilities.includes(capability));
  },
};