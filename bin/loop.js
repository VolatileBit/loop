#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const require = createRequire(path.join(pkgRoot, 'package.json'));
const tsxImport = require.resolve('tsx');
const entry = path.join(pkgRoot, 'src', 'bin.ts');

const result = spawnSync(process.execPath, ['--import', tsxImport, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
