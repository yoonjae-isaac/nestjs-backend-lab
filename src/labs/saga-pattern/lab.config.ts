export const sagaPatternLabConfig = {
  infrastructure: {
    kafka: true,
    postgres: true,
    services: ['ORDER', 'INVENTORY', 'PAYMENT', 'SHIPPING', 'ORCHESTRATOR'],
  },
  name: 'saga-pattern',
  strategies: ['CHOREOGRAPHY', 'ORCHESTRATION'],
} as const;
