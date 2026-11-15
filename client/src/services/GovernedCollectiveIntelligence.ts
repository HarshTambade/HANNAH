export const GovernedCollectiveIntelligence = {
  members: [] as string[],
  quarantine: [] as string[],
  admit(member: string) {
    this.members.push(member);
  },
  flagSuspicious(contribution: string) {
    this.quarantine.push(contribution);
  },
};