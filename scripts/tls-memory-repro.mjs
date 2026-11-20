import { createServer } from 'node:https';
import { connect } from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT_KIB = 100 * 1024;
const MAX_GROWTH_KIB = 15 * 1024;
const COUNT = 3000;

function localAddress() {
  const address = Object.values(networkInterfaces()).flat().find(item => item?.internal && item.family === 'IPv4');
  if (!address) throw new Error('An internal IPv4 interface is required');
  return address.address;
}

function rssKiB(pid) {
  return Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

async function worker(port, host) {
  if (Bun.version !== '1.4.4') throw new Error('The memory gate requires Bun 1.4.4');
  if (host !== localAddress()) throw new Error('The memory gate requires an internal interface');
  const samples = [];
  for (let i = 1; i <= COUNT; i++) {
    await new Promise((resolve, reject) => {
      const socket = connect({ host, port, rejectUnauthorized: false }, () => {
        socket.write('GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
      });
      socket.on('data', () => {});
      socket.once('error', reject);
      socket.once('close', resolve);
    });
    if (i % 100 === 0) {
      const memory = process.memoryUsage();
      const sample = { connections: i, rssKiB: rssKiB(process.pid), heapUsed: memory.heapUsed, external: memory.external };
      samples.push(sample);
      if (sample.rssKiB > LIMIT_KIB) throw new Error('TLS RSS exceeded 100 MiB');
    }
  }
  const at2000 = samples.find(sample => sample.connections === 2000);
  const final = samples.at(-1);
  if (!at2000 || !final || final.rssKiB - at2000.rssKiB > MAX_GROWTH_KIB) {
    throw new Error('TLS RSS did not plateau during the final 1000 connections');
  }
  process.stdout.write(JSON.stringify({ status: 'passed', runtime: Bun.version, connections: COUNT, at2000, final }) + '\n');
}

async function parent(binary) {
  if (!binary || !binary.startsWith('/')) throw new Error('Pass an absolute path to Bun 1.4.4');
  const directory = await mkdtemp(join(tmpdir(), 'silo-tls-memory-'));
  let server;
  try {
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=example.test'], { stdio: 'ignore', timeout: 10000 });
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.end('OK'));
    const host = localAddress();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const child = spawn(binary, ['--no-env-file', fileURLToPath(import.meta.url), '--worker', String(server.address().port), host], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
      stdio: 'inherit'
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code !== 0) throw new Error(`TLS memory worker exited with ${code}`);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') await worker(Number(process.argv[3]), process.argv[4]);
else await parent(process.argv[2]);
