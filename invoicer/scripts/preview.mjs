// Disposable local preview. Never connects to a remote D1 or deploys a Worker.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = resolve('.'); const directory = join(root, '.wrangler/preview');
await mkdir(directory, { recursive: true });
let key;
try { key = (await readFile(join(directory, '.dev.vars'), 'utf8')).trim().slice('ADMIN_KEY='.length); } catch { key = randomBytes(32).toString('hex'); await writeFile(join(directory, '.dev.vars'), `ADMIN_KEY=${key}\n`, { mode: 0o600 }); }
const config = join(directory, 'wrangler.jsonc');
await writeFile(config, JSON.stringify({ name: 'invoicer-preview', main: join(root, 'src/worker/index.ts'), compatibility_date: '2026-10-07', compatibility_flags: ['nodejs_compat'], assets: { directory: join(root, 'dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true }, d1_databases: [{ binding: 'DB', database_name: 'invoicer-preview', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: join(root, 'migrations') }] }));
function wrangler(args) { return spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', config], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'logs') } }); }
const migration = wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', join(directory, 'state')]);
const code = await new Promise(r => migration.on('exit', r)); if (code !== 0) process.exit(code || 1);
console.log('Preview only: http://127.0.0.1:8788. The local admin key is stored in .wrangler/preview/.dev.vars (never committed).');
const worker = wrangler(['dev', '--ip', '127.0.0.1', '--port', '8788', '--persist-to', join(directory, 'state')]);
process.on('SIGTERM', () => worker.kill('SIGTERM')); process.on('SIGINT', () => worker.kill('SIGINT'));
await new Promise(r => worker.on('exit', r));
