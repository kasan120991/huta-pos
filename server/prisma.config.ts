import 'dotenv/config'
import path from 'node:path'
import { defineConfig } from '@prisma/config'

/**
 * Prisma 7 moved the connection URL out of schema.prisma — the datasource block there
 * declares only the provider, and `url` in the schema is a hard validation error.
 *
 * NOTE: the driver adapter (`PrismaPg` from `@prisma/adapter-pg`) does NOT belong here.
 * `PrismaConfig` has no `adapter` key in 7.x; the adapter is passed to the `PrismaClient`
 * constructor in application code:
 *
 *   new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
 *
 * The `datasource.url` below is what the migration engine and Studio use.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: { url: process.env.DATABASE_URL! },
})
