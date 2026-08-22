-- Cash carries over. The drawer is not emptied between shifts or between days; it holds what
-- the last close counted until the owner collects it. Two consequences live here.

-- 1. The owner's collection is its own kind of movement. It subtracts from expected exactly
--    as a safe drop does, but it is the event that RESETS the till and the figure to total
--    separately. Writing it is admin-only, enforced in the service: a cashier who can key a
--    $500 pickup can paper over a $500 shortfall.
ALTER TYPE "CashMovementType" ADD VALUE 'PICKUP';

-- 2. The opening count becomes a reconciliation against the previous close, which is the only
--    control on cash going missing between shifts. Before this, the register accepted any
--    opening figure without question: in the dev data a drawer closed at $728.16 and the next
--    opened at $0.00, recording no variance at all.
ALTER TABLE "Shift" ADD COLUMN "openingExpectedCents" INTEGER;
ALTER TABLE "Shift" ADD COLUMN "openingVarianceCents" INTEGER;

-- Never half a record, the same all-or-nothing rule the close already follows.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_opening_variance_pairing_check"
  CHECK (("openingExpectedCents" IS NULL) = ("openingVarianceCents" IS NULL));

-- The arithmetic itself, so a wrong figure cannot be stored at all.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_opening_variance_math_check"
  CHECK (
    "openingVarianceCents" IS NULL
    OR "openingVarianceCents" = "openingCashCents" - "openingExpectedCents"
  );
