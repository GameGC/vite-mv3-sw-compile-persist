export default {
  manifest_version: 3,
  name: 'Job Scraper Extension',
  version: '1.0.0',
  description: 'Automated Job Scraper with MV3 Persistence',
  permissions: [
    'alarms',
    'storage',
    'tabs',
    'notifications',
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
};
