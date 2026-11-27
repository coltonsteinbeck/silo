import { expect, test } from 'bun:test';
import { resolvePostgresTransport } from '../../database/postgres';

test('enforces verified PostgreSQL TLS and preserves an explicit certificate path', () => {
  const options = resolvePostgresTransport(
    'postgresql://db.example.test/silo?sslmode=require&sslrootcert=local-ca.pem',
    true
  );
  expect(options.ssl).toEqual({ rejectUnauthorized: true });
  const url = new URL(options.connectionString);
  expect(url.searchParams.get('sslmode')).toBe('verify-full');
  expect(url.searchParams.get('sslrootcert')).toBe('local-ca.pem');
});

test('requires verified TLS for hosted Supabase and permits plain local development', () => {
  expect(resolvePostgresTransport('postgresql://db.example.supabase.co/silo').ssl).toEqual({
    rejectUnauthorized: true
  });
  expect(() =>
    resolvePostgresTransport('postgresql://db.example.supabase.co/silo?sslmode=disable')
  ).toThrow('server certificate verification');
  expect(resolvePostgresTransport('postgresql://127.0.0.1/silo').ssl).toBe(false);
});

test('uses the effective driver host and honors verified environment TLS', () => {
  expect(
    resolvePostgresTransport('postgresql://local/silo?host=db.example.supabase.co').ssl
  ).toEqual({ rejectUnauthorized: true });
  expect(
    resolvePostgresTransport('postgresql://db.example.test/silo', false, 'verify-full').ssl
  ).toEqual({ rejectUnauthorized: true });
  expect(resolvePostgresTransport('postgresql://dev.example.test/silo', false, 'disable').ssl).toBe(
    false
  );
});

test.each(['?ssl=no-verify', '?sslmode=no-verify'])(
  'rejects insecure TLS URL options %s',
  query => {
    expect(() => resolvePostgresTransport(`postgresql://db.example.test/silo${query}`)).toThrow(
      'server certificate verification'
    );
  }
);
