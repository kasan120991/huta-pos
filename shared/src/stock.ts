/**
 * Stock status vocabulary.
 *
 * At the root entry rather than behind `@huta/shared/schemas` because both the API routes
 * and the register's Vue components need these values, and the schemas subpath pulls Zod
 * in with it. Plain string arrays with no runtime dependency, same as ADJUSTMENT_REASONS.
 */

/**
 * Where stock sits against its reorder point. Resolved SERVER-SIDE, never by the client.
 *
 * The client cannot derive this correctly even if it wanted to: the threshold falls back
 * through the product's category, which the client does not have, and a bare quantity
 * carries no unit — `3` is three items or three MILLIGRAMS depending on the variant's
 * tracking mode. Deriving it in a table cell is what marked a gram of flower as healthy
 * and only turned it amber at 3mg.
 */
export const STOCK_STATUSES = ['OUT', 'LOW', 'OK'] as const
export type StockStatus = (typeof STOCK_STATUSES)[number]

/**
 * The stock filter the catalog offers. `all` is the absence of a filter. `on-hand` is
 * quantity-based ("anything actually on the shelf in scope"), not status-based — the
 * product roll-up status is worst-of-variants, so NOT-OUT would wrongly exclude a
 * product holding stock on one variant while another sits at zero.
 */
export const STOCK_FILTERS = ['all', 'out', 'low', 'on-hand'] as const
export type StockFilter = (typeof STOCK_FILTERS)[number]

export const STOCK_STATUS_LABELS: Readonly<Record<StockStatus, string>> = {
  OUT: 'Out',
  LOW: 'Low',
  OK: 'In stock',
}
