import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const action = process.argv[2];
const labName = process.argv[3];
const supportedActions = new Set(['up', 'down', 'logs', 'config']);

if (!supportedActions.has(action) || !labName || !/^[a-z0-9-]+$/.test(labName)) {
  process.stderr.write('Usage: pnpm lab:<up|down|logs|config> <lab-name>\n');
  process.exit(1);
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const labCompose = join(repositoryRoot, 'infra', 'labs', labName, 'compose.yml');

if (!existsSync(labCompose)) {
  process.stderr.write(`Unknown lab: ${labName}\n`);
  process.exit(1);
}

const labInfrastructure = {
  'cache-stampede': ['postgres.yml', 'redis.yml', 'nginx.yml'],
  'inventory-concurrency': ['postgres.yml', 'redis.yml', 'kafka.yml', 'kafka-ui.yml', 'nginx.yml'],
  'saga-pattern': ['postgres.yml', 'kafka.yml', 'kafka-ui.yml', 'nginx.yml'],
};
const infrastructureFiles = labInfrastructure[labName];

if (!infrastructureFiles) {
  process.stderr.write(`Infrastructure mapping is missing for lab: ${labName}\n`);
  process.exit(1);
}

const composeFiles = infrastructureFiles
  .map((fileName) => join(repositoryRoot, 'infra', 'shared', fileName))
  .concat(labCompose);
const composeArguments = [
  'compose',
  '--project-directory',
  repositoryRoot,
  '--project-name',
  `lab-${labName}`,
  ...composeFiles.flatMap((fileName) => ['-f', fileName]),
];

if (action === 'up') {
  composeArguments.push('up', '-d', '--build');
  if (labName === 'inventory-concurrency' || labName === 'cache-stampede') {
    composeArguments.push('--scale', 'app=3');
  }
} else if (action === 'down') {
  composeArguments.push('down', '--remove-orphans');
} else if (action === 'logs') {
  composeArguments.push('logs', '--follow');
} else {
  composeArguments.push('config');
}

const portDefaultsByLab = {
  'cache-stampede': {
    KAFKA_PORT: '39092',
    KAFKA_UI_PORT: '38080',
    LAB_HTTP_PORT: '8090',
    POSTGRES_PORT: '35432',
    REDIS_PORT: '36379',
  },
  'inventory-concurrency': {
    KAFKA_PORT: '19092',
    KAFKA_UI_PORT: '18080',
    LAB_HTTP_PORT: '8088',
    POSTGRES_PORT: '15432',
    REDIS_PORT: '16379',
  },
  'saga-pattern': {
    KAFKA_PORT: '29092',
    KAFKA_UI_PORT: '28080',
    LAB_HTTP_PORT: '8089',
    POSTGRES_PORT: '25432',
    REDIS_PORT: '26379',
  },
};
const defaultPorts = portDefaultsByLab[labName];
const labPorts = {
  KAFKA_PORT: process.env.KAFKA_PORT ?? defaultPorts.KAFKA_PORT,
  KAFKA_UI_PORT: process.env.KAFKA_UI_PORT ?? defaultPorts.KAFKA_UI_PORT,
  LAB_HTTP_PORT: process.env.LAB_HTTP_PORT ?? defaultPorts.LAB_HTTP_PORT,
  POSTGRES_PORT: process.env.POSTGRES_PORT ?? defaultPorts.POSTGRES_PORT,
  REDIS_PORT: process.env.REDIS_PORT ?? defaultPorts.REDIS_PORT,
};
const command = spawnSync('docker', composeArguments, {
  cwd: repositoryRoot,
  env: { ...process.env, ...labPorts },
  stdio: 'inherit',
});
process.exit(command.status ?? 1);
