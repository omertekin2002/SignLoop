export type Contract = {
  id: string;
  title: string;
  status: 'DRAFT' | 'ANALYZED';
  createdAt: string;
  text?: string; // Content of the contract
  analyses?: any[];
  latestAnalysis?: any;
};

// Global store to persist across hot reloads in dev
const globalForStore = global as unknown as { contracts: Contract[] };

if (!globalForStore.contracts) {
  globalForStore.contracts = [];
}

export const db = {
  contracts: globalForStore.contracts,
};
