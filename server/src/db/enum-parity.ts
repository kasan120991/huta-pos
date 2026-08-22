/**
 * Compile-time proof that the hand-written enum mirrors in `@huta/shared` match the enums
 * Prisma generates from `schema.prisma`.
 *
 * `shared/` cannot import the generated client — it is gitignored, and its entry points
 * value-import `@prisma/client/runtime/*`, which would drag the Prisma runtime into the
 * register's browser bundle. So the mirrors are maintained by hand, and this file is the
 * safety net that stops them drifting.
 *
 * Nothing imports this module. `tsc` checks it anyway. Change an enum in the schema
 * without changing `shared/src/enums.ts` in the same commit and `pnpm typecheck` fails
 * here rather than something subtle going wrong at runtime months later.
 *
 * `import type` is fully erased under `verbatimModuleSyntax`, so this file adds no
 * runtime dependency in either direction.
 */

import type * as Prisma from '../generated/prisma/enums.js'
import type * as Shared from '@huta/shared'

/** Wrapped in tuples to defeat union distribution, so the unions compare as wholes. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Assert<T extends true> = T

/**
 * Both the KEY set and the VALUE set must match, in both directions.
 *
 * The key check matters independently: `{ ADMINISTRATOR: 'ADMIN' }` produces the correct
 * value union but the wrong key, and would slip past a value-only assertion.
 */
type SameEnum<
  S extends Record<string, string>,
  P extends Record<string, string>,
> = Exact<keyof S, keyof P> extends true
  ? Exact<S[keyof S], P[keyof P]> extends true
    ? true
    : false
  : false

type _Role = Assert<SameEnum<typeof Shared.Role, typeof Prisma.Role>>
type _TrackingMode = Assert<SameEnum<typeof Shared.TrackingMode, typeof Prisma.TrackingMode>>
type _StrainType = Assert<SameEnum<typeof Shared.StrainType, typeof Prisma.StrainType>>
type _MovementType = Assert<SameEnum<typeof Shared.MovementType, typeof Prisma.MovementType>>
type _TransferStatus = Assert<SameEnum<typeof Shared.TransferStatus, typeof Prisma.TransferStatus>>
type _PurchaseOrderStatus = Assert<
  SameEnum<typeof Shared.PurchaseOrderStatus, typeof Prisma.PurchaseOrderStatus>
>
type _SaleStatus = Assert<SameEnum<typeof Shared.SaleStatus, typeof Prisma.SaleStatus>>
type _PaymentMethod = Assert<SameEnum<typeof Shared.PaymentMethod, typeof Prisma.PaymentMethod>>
type _PaymentStatus = Assert<SameEnum<typeof Shared.PaymentStatus, typeof Prisma.PaymentStatus>>
type _ShiftStatus = Assert<SameEnum<typeof Shared.ShiftStatus, typeof Prisma.ShiftStatus>>
type _CashMovementType = Assert<
  SameEnum<typeof Shared.CashMovementType, typeof Prisma.CashMovementType>
>
type _PromotionScope = Assert<SameEnum<typeof Shared.PromotionScope, typeof Prisma.PromotionScope>>
type _DiscountType = Assert<SameEnum<typeof Shared.DiscountType, typeof Prisma.DiscountType>>
type _LoyaltyTransactionType = Assert<
  SameEnum<typeof Shared.LoyaltyTransactionType, typeof Prisma.LoyaltyTransactionType>
>

export {}
