import mysql from 'mysql2/promise'

/**
 * Read-only connection to the legacy `huta-old` MySQL database running under MAMP.
 *
 * This script NEVER writes to the legacy database. It is the historical record and the
 * only copy — treat it as strictly read-only.
 */

export interface LegacyProduct {
  id: number
  title: string
  supplier: number | null
  category: number
  price: number | null
  purchase_price: number | null
  on_hand: number
  count: number
  on_low: number | null
  description: string | null
  image: string | null
  cannabinoids: string | null
  concentration: number | null
  concentration_uom: string | null
}

export interface LegacySupplier {
  id: number
  company: string
  website: string | null
  contact_name: string | null
  contact_title: string | null
  contact_phone: string | null
  contact_email: string | null
}

export interface LegacyCategory {
  id: number
  category: string
}

const SOCKET = '/Applications/MAMP/tmp/mysql/mysql.sock'

export async function connectLegacy(): Promise<mysql.Connection> {
  return mysql.createConnection({
    socketPath: process.env.LEGACY_MYSQL_SOCKET ?? SOCKET,
    user: process.env.LEGACY_MYSQL_USER ?? 'root',
    password: process.env.LEGACY_MYSQL_PASSWORD ?? 'root',
    database: process.env.LEGACY_MYSQL_DATABASE ?? 'huta-old',
    // The legacy schema stores money as DOUBLE. Let mysql2 hand us numbers; we round to
    // cents at the mapping boundary rather than trusting the float.
    supportBigNumbers: true,
  })
}

export async function fetchLegacyProducts(
  connection: mysql.Connection,
): Promise<LegacyProduct[]> {
  const [rows] = await connection.query(
    `SELECT id, title, supplier, category, price, purchase_price, on_hand, count,
            on_low, description, image, cannabinoids, concentration, concentration_uom
     FROM products
     ORDER BY id`,
  )
  return rows as LegacyProduct[]
}

export async function fetchLegacySuppliers(
  connection: mysql.Connection,
): Promise<LegacySupplier[]> {
  const [rows] = await connection.query(
    `SELECT id, company, website, contact_name, contact_title, contact_phone, contact_email
     FROM suppliers ORDER BY id`,
  )
  return rows as LegacySupplier[]
}

export async function fetchLegacyCategories(
  connection: mysql.Connection,
): Promise<LegacyCategory[]> {
  const [rows] = await connection.query(`SELECT id, category FROM categories ORDER BY id`)
  return rows as LegacyCategory[]
}
