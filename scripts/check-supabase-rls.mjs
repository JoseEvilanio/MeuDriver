import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations')

if (!fs.existsSync(migrationsDir)) {
  console.error('Migrations directory not found:', migrationsDir)
  process.exit(1)
}

const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.toLowerCase().endsWith('.sql'))
  .sort()

const forbiddenPatterns = [
  /create\s+policy\s+"?authenticated_upload_to_meudriver"?\s+on\s+storage\.objects\s+for\s+insert/i,
  /for\s+insert\s+to\s+authenticated\s+with\s+check\s*\(\s*bucket_id\s*=\s*'MeuDriver'\s*\)/i,
  /with\s+check\s*\(\s*bucket_id\s*=\s*'MeuDriver'\s*\)/i,
]

const offenders = []
for (const file of migrationFiles) {
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
  const matches = forbiddenPatterns.filter((pattern) => pattern.test(content))
  if (matches.length > 0) {
    offenders.push({ file, matches: matches.length })
  }
}

if (offenders.length > 0) {
  console.error('Forbidden permissive Supabase Storage policy detected in migration(s):')
  for (const offender of offenders) {
    console.error(`- ${offender.file} (${offender.matches} forbidden pattern(s))`)
  }
  console.error('The bucket must remain isolated by auth.uid() and cannot allow all authenticated users to upload to the same bucket without a user-scoped check.')
  process.exit(1)
}

console.log('Supabase RLS validation passed: no permissive bucket-wide upload policy detected.')
