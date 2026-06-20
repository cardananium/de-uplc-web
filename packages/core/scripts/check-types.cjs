#!/usr/bin/env node
// Drift guard: the generated debugger-types/index.ts must have been produced from the
// committed debugger-types/combined_schema.json. If the schema is updated without
// regenerating (or vice-versa), the embedded sha256 won't match — fail loudly.
// Run in CI so the codegen contract is auditable in-repo (the Rust serde → schema →
// TS chain can otherwise drift silently). Regenerate with: npm run generate-types.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'debugger-types');
const schemaPath = path.join(dir, 'combined_schema.json');
const indexPath = path.join(dir, 'index.ts');

const actual = crypto.createHash('sha256').update(fs.readFileSync(schemaPath)).digest('hex');
const header = fs.readFileSync(indexPath, 'utf8').slice(0, 600);
const m = header.match(/schema-sha256:\s*([0-9a-f]{64})/);

if (!m) {
  console.error('❌ debugger-types/index.ts has no `schema-sha256` header — regenerate with `npm run generate-types`.');
  process.exit(1);
}
if (m[1] !== actual) {
  console.error('❌ debugger-types/index.ts is STALE vs combined_schema.json:');
  console.error(`   index.ts header : ${m[1]}`);
  console.error(`   committed schema: ${actual}`);
  console.error('   → run `npm run generate-types` (after copying a fresh schema if the Rust types changed).');
  process.exit(1);
}
console.log(`✓ debugger-types in sync with combined_schema.json (sha256 ${actual.slice(0, 12)}…)`);
