import { execSync } from 'node:child_process'

/**
 * Integration-test database.
 *
 * A SEPARATE database from the dev one, created and migrated once per run. The house rules
 * forbids `prisma migrate reset` against anything but the local container, and running
 * tests against the dev database would destroy the seeded catalog the app is being built
 * against. `migrate deploy` never drops anything.
 */

const TEST_DB = 'huta_pos_test'
const ADMIN_URL = 'postgresql://huta:huta@localhost:55432/postgres?schema=public'

export const TEST_DATABASE_URL = `postgresql://huta:huta@localhost:55432/${TEST_DB}?schema=public`

export async function setup(): Promise<void> {
  const { Client } = await import('pg')

  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${TEST_DB}"`)
  } catch (error) {
    // 42P01 duplicate_database — already there, which is the normal case on a re-run.
    const code = (error as { code?: string }).code
    if (code !== '42P04') throw error
  } finally {
    await admin.end()
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  })
}
