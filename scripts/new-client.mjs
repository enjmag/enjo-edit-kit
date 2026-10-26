#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || slug === '--help') {
  console.log('Usage: npm run new-client -- <lowercase-client-slug>');
  process.exit(slug ? 0 : 1);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Use a lowercase kebab-case slug, not a path.');
const dest = join(root, 'clients', slug);
if (existsSync(dest)) throw new Error(`Client already exists: ${slug}.`);
cpSync(join(root, 'clients/_template'), dest, { recursive: true, errorOnExist: true });
const name = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
for (const file of readdirSync(dest).filter(f => f.endsWith('.md'))) {
  const path = join(dest, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace('CLIENT NAME', name));
}
console.log(`Created clients/${slug}. Fill BRIEF.md and BRAND.md, then run: npm run check:brief -- clients/${slug}`);
