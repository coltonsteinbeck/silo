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
