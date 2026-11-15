export const AgentNativeHomeService = {
  home: { region: "local", uptime: 0, connections: [] as string[] },
  provision(region = "local") {
    this.home.region = region;
    this.home.uptime = Date.now();
  },
  migrate(region: string) {
    const previous = { ...this.home };
    this.provision(region);
    return { previous, current: this.home };
  },
};