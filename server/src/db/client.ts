import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../generated/prisma/client.js'

/**
 * The single PrismaClient for the process.
 *
 * Prisma 7 requires a driver adapter, and it goes HERE — not in `prisma.config.ts`, whose
 * `PrismaConfig` type has no `adapter` key. The `datasource.url` in that file is only for
 * the migration engine and Studio.
 *
 * `pg` is a transitive dependency of `@prisma/adapter-pg` and is not declared by this
 * package, so under pnpm's strict layout we cannot import it to build our own Pool. The
 * PoolConfig form below lets the adapter construct it.
 */

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy server/.env.example to server/.env.')
}

const adapter = new PrismaPg({ connectionString })

export const prisma = new PrismaClient({ adapter })
