// Regenerates lib/schema-org/organization-types.generated.ts from the official
// schema.org vocabulary. Pure Node stdlib (global fetch); no runtime dependency
// is added to the app — the output is a plain string list checked into the repo.
//
//   node scripts/gen-schema-org-types.mjs
//
// It computes the transitive rdfs:subClassOf closure of schema.org
// "Organization" (inclusive). That is the maintained source of truth for
// "is this @type a kind of Organization", replacing the previous hand-kept
// list that silently omitted LocalBusiness leaf subtypes (HVACBusiness,
// Plumber, Attorney, Dentist, …) and so under-reported real businesses.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SOURCE = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../lib/schema-org/organization-types.generated.ts',
);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
const graph = (await res.json())['@graph'];

const strip = (id) => (typeof id === 'string' ? id.replace(/^schema:/, '') : null);
const children = new Map();
for (const node of graph) {
  const t = node['@type'];
  const isClass = t === 'rdfs:Class' || (Array.isArray(t) && t.includes('rdfs:Class'));
  if (!isClass) continue;
  const id = strip(node['@id']);
  if (!id) continue;
  let sup = node['rdfs:subClassOf'] ?? [];
  if (!Array.isArray(sup)) sup = [sup];
  for (const p of sup.map((s) => strip(s?.['@id'])).filter(Boolean)) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(id);
  }
}

const out = new Set(['Organization']);
const q = ['Organization'];
while (q.length) {
  for (const ch of children.get(q.shift()) ?? []) {
    if (!out.has(ch)) { out.add(ch); q.push(ch); }
  }
}
const types = [...out].sort();

const body = `// GENERATED FILE — do not edit by hand.
// Source: ${SOURCE}
// Regenerate: node scripts/gen-schema-org-types.mjs
// Generated: ${new Date().toISOString()}
//
// The transitive subclass closure of schema.org "Organization" (inclusive):
// every @type that is a kind of Organization, including the full LocalBusiness
// subtree. Use ORGANIZATION_TYPES_LOWER for case-insensitive membership tests.

export const ORGANIZATION_TYPES: readonly string[] = [
${types.map((t) => `  '${t}',`).join('\n')}
];

export const ORGANIZATION_TYPES_LOWER: ReadonlySet<string> = new Set(
  ORGANIZATION_TYPES.map((t) => t.toLowerCase()),
);
`;
writeFileSync(OUT, body);
console.log(`wrote ${types.length} Organization descendants -> ${OUT}`);
