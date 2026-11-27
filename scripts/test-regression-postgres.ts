import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--pr')) {
  throw new Error('Expected no arguments or --pr');
}
const release = args.length === 0;
const input = process.env.SILO_REGRESSION_DATABASE_URL;
const target = input && URL.canParse(input) ? new URL(input) : undefined;
const name = target?.pathname.slice(1) ?? '';
const localAddresses = Object.values(networkInterfaces())
  .flat()
  .filter(address => address?.internal && address.family === 'IPv4')
  .map(address => address?.address);
if (
  !target ||
  !['postgresql:', 'postgres:'].includes(target.protocol) ||
  !localAddresses.includes(target.hostname) ||
  !target.port ||
  target.search ||
  target.hash ||
  !/^silo_regression_[a-f0-9]{32}$/.test(name)
) {
  throw new Error('A loopback disposable regression database with an explicit port is required');
}

const child = Bun.spawn(
  [
    process.execPath,
    '--no-env-file',
    'test',
    'packages/bot/src/__tests__/database/quota-reservation-postgres.integration.test.ts',
    ...(release
      ? ['packages/bot/src/__tests__/database/pool-reuse-postgres.integration.test.ts']
      : [])
  ],
  {
    env: {
      PATH: process.env.PATH,
      RUN_QUOTA_DB_TESTS: 'true',
      RUN_INGRESS_DB_TESTS: 'true',
      QUOTA_TEST_DATABASE_URL: input,
      RUN_POOL_REUSE_DB_TESTS: 'true',
      POOL_REUSE_TEST_DATABASE_URL: input,
      POOL_REUSE_TEST_DATABASE_PORT: target.port,
      POOL_REUSE_TEST_DATABASE_NAME: name
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit'
  }
);
process.exitCode = await child.exited;
