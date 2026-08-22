import { TEST_DATABASE_URL, setup } from './db.js'

/**
 * Runs once before the integration project. Creating the database and applying migrations
 * here rather than per-file keeps a full run to one schema build.
 */
export default async function globalSetup(): Promise<void> {
  process.env['DATABASE_URL'] = TEST_DATABASE_URL
  await setup()
}
