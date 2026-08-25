-- CreateEnum
CREATE TYPE "PayRunStatus" AS ENUM ('COMMITTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('CASH', 'CHECK', 'BANK');

-- CreateTable
CREATE TABLE "WageRate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ratePerHourCents" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveFromDate" TEXT NOT NULL,
    "setById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WageRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRun" (
    "id" TEXT NOT NULL,
    "periodStartDate" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "PayRunStatus" NOT NULL DEFAULT 'COMMITTED',
    "totalMinutes" INTEGER NOT NULL,
    "overtimeMinutes" INTEGER NOT NULL,
    "regularCents" INTEGER NOT NULL,
    "overtimeCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "committedById" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalNote" TEXT,
    "note" TEXT,

    CONSTRAINT "PayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayLine" (
    "id" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalMinutes" INTEGER NOT NULL,
    "regularMinutes" INTEGER NOT NULL,
    "overtimeMinutes" INTEGER NOT NULL,
    "regularCents" INTEGER NOT NULL,
    "overtimeCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayWeek" (
    "id" TEXT NOT NULL,
    "payLineId" TEXT NOT NULL,
    "weekStartDate" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "minutesWorked" INTEGER NOT NULL,
    "regularMinutes" INTEGER NOT NULL,
    "overtimeMinutes" INTEGER NOT NULL,
    "ratePerHourCents" INTEGER NOT NULL,
    "wageRateId" TEXT,
    "regularCents" INTEGER NOT NULL,
    "overtimeCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,

    CONSTRAINT "PayWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPayout" (
    "id" TEXT NOT NULL,
    "payLineId" TEXT NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "cashMovementId" TEXT,
    "paidById" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalNote" TEXT,
    "reversalCashMovementId" TEXT,

    CONSTRAINT "PayPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WageRate_userId_effectiveFrom_idx" ON "WageRate"("userId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayRun_periodStart_idx" ON "PayRun"("periodStart");

-- CreateIndex
CREATE INDEX "PayRun_status_periodStart_idx" ON "PayRun"("status", "periodStart");

-- CreateIndex
CREATE INDEX "PayLine_userId_idx" ON "PayLine"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayLine_payRunId_userId_key" ON "PayLine"("payRunId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayWeek_payLineId_weekStartDate_key" ON "PayWeek"("payLineId", "weekStartDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayPayout_cashMovementId_key" ON "PayPayout"("cashMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "PayPayout_reversalCashMovementId_key" ON "PayPayout"("reversalCashMovementId");

-- CreateIndex
CREATE INDEX "PayPayout_payLineId_idx" ON "PayPayout"("payLineId");

-- AddForeignKey
ALTER TABLE "WageRate" ADD CONSTRAINT "WageRate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WageRate" ADD CONSTRAINT "WageRate_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_committedById_fkey" FOREIGN KEY ("committedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_payLineId_fkey" FOREIGN KEY ("payLineId") REFERENCES "PayLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_wageRateId_fkey" FOREIGN KEY ("wageRateId") REFERENCES "WageRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_payLineId_fkey" FOREIGN KEY ("payLineId") REFERENCES "PayLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_cashMovementId_fkey" FOREIGN KEY ("cashMovementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_reversalCashMovementId_fkey" FOREIGN KEY ("reversalCashMovementId") REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants. Rules Prisma's schema language cannot express, in the database
-- where a bad migration, a manual psql session and a future bug all bounce off
-- them. Payroll is the table someone gets paid from, so the arithmetic itself
-- is asserted rather than only the shapes.
-- ---------------------------------------------------------------------------

-- A wage is a positive number. Zero is not a rate — it is a missing rate, and payroll
-- treats it as a blocker rather than paying somebody nothing while reconciling perfectly.
ALTER TABLE "WageRate" ADD CONSTRAINT "WageRate_rate_check"
    CHECK ("ratePerHourCents" > 0);

-- Effective dates are Sundays. This is what guarantees a workweek carries exactly one rate,
-- so FLSA's blended-regular-rate rule can never fire. The column is a bare calendar date, so
-- casting it to `date` involves no timezone and the assertion is honest in SQL.
ALTER TABLE "WageRate" ADD CONSTRAINT "WageRate_effective_dow_check"
    CHECK (EXTRACT(DOW FROM "effectiveFromDate"::date) = 0);

-- ── pay runs ──────────────────────────────────────────────────────────────

-- One LIVE run per fortnight. Partial, so a REVERSED run does not block the re-run — the same
-- technique as TimeEntry_one_open_per_user, which Prisma also cannot declare. This index is
-- what serialises two admins committing the same period at once.
CREATE UNIQUE INDEX "PayRun_one_live_per_period"
    ON "PayRun"("periodStartDate") WHERE "status" = 'COMMITTED';

ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_period_order_check"
    CHECK ("periodEnd" > "periodStart");

ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_period_dow_check"
    CHECK (EXTRACT(DOW FROM "periodStartDate"::date) = 0);

-- Never half a reversal record: the reverser and the timestamp are written together or not
-- at all, the pairing rule Shift's review sign-off already carries.
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_reversal_pairing_check"
    CHECK (("reversedById" IS NULL) = ("reversedAt" IS NULL));

ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_reversal_status_check"
    CHECK (("status" = 'REVERSED') = ("reversedAt" IS NOT NULL));

-- A reversed pay run without a reason is not an audit trail — the same sentence
-- TimeEntry_reason_check exists for.
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_reversal_reason_check"
    CHECK ("status" <> 'REVERSED' OR "reversalNote" IS NOT NULL);

ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_math_check"
    CHECK ("grossCents" = "regularCents" + "overtimeCents");

ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_nonnegative_check"
    CHECK (
      "grossCents" >= 0 AND "regularCents" >= 0 AND "overtimeCents" >= 0
      AND "totalMinutes" >= 0 AND "overtimeMinutes" >= 0
      AND "overtimeMinutes" <= "totalMinutes"
    );

-- ── pay lines ─────────────────────────────────────────────────────────────

ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_minutes_math_check"
    CHECK ("totalMinutes" = "regularMinutes" + "overtimeMinutes");

ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_gross_math_check"
    CHECK ("grossCents" = "regularCents" + "overtimeCents");

-- A line with no time on it should not exist; nobody is paid for a fortnight they did not work.
ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_worked_check"
    CHECK ("totalMinutes" > 0);

ALTER TABLE "PayLine" ADD CONSTRAINT "PayLine_nonnegative_check"
    CHECK (
      "regularMinutes" >= 0 AND "overtimeMinutes" >= 0
      AND "regularCents" >= 0 AND "overtimeCents" >= 0 AND "grossCents" >= 0
    );

-- ── pay weeks: where FLSA actually lives ──────────────────────────────────

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_week_dow_check"
    CHECK (EXTRACT(DOW FROM "weekStartDate"::date) = 0);

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_week_order_check"
    CHECK ("weekEnd" > "weekStart");

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_rate_check"
    CHECK ("ratePerHourCents" > 0);

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_minutes_math_check"
    CHECK ("minutesWorked" = "regularMinutes" + "overtimeMinutes");

-- The overtime rule itself, in SQL: you cannot bank an overtime minute before forty hours
-- are full. 2400 minutes is the FLSA weekly threshold.
ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_overtime_threshold_check"
    CHECK (
      "regularMinutes" <= 2400
      AND ("overtimeMinutes" = 0 OR "regularMinutes" = 2400)
    );

-- The pay arithmetic itself, so a wrong figure cannot be stored even by a direct UPDATE —
-- the descendant of Shift_opening_variance_math_check.
--
-- divRoundHalfUp(a, d) is floor((2a + d) / 2d). Both numerators here are non-negative, so
-- Postgres's truncating integer division IS floor and the two spellings agree exactly.
--   regular:  divRoundHalfUp(rate * minutes,     60)  ->  (rate*min*2 + 60)  / 120
--   overtime: divRoundHalfUp(rate * minutes * 3, 120) ->  (rate*min*6 + 120) / 240
-- ::bigint because a high rate over a long week overflows int4 in the intermediate
-- (50000 * 10080 * 6 is 3.0e9, past 2.1e9).
ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_regular_math_check"
    CHECK ("regularCents" = ("ratePerHourCents"::bigint * "regularMinutes" * 2 + 60) / 120);

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_overtime_math_check"
    CHECK ("overtimeCents" = ("ratePerHourCents"::bigint * "overtimeMinutes" * 6 + 120) / 240);

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_gross_math_check"
    CHECK ("grossCents" = "regularCents" + "overtimeCents");

ALTER TABLE "PayWeek" ADD CONSTRAINT "PayWeek_nonnegative_check"
    CHECK (
      "minutesWorked" >= 0 AND "regularMinutes" >= 0 AND "overtimeMinutes" >= 0
      AND "regularCents" >= 0 AND "overtimeCents" >= 0 AND "grossCents" >= 0
    );

-- ── payouts ───────────────────────────────────────────────────────────────

ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_amount_check"
    CHECK ("amountCents" > 0);

-- The constraint that makes the drawer reconcile. A cash payout MUST have written a drawer
-- movement, and a bank transfer must not have. Without this, cash could leave the till with
-- nothing in the ledger and the next close would report a shortfall nobody could explain.
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_cash_pairing_check"
    CHECK (("method" = 'CASH') = ("cashMovementId" IS NOT NULL));

ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_reversal_pairing_check"
    CHECK (("reversedById" IS NULL) = ("reversedAt" IS NULL));

ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_reversal_reason_check"
    CHECK ("reversedAt" IS NULL OR "reversalNote" IS NOT NULL);

-- A reversed CASH payout must have put the money back; a reversed transfer must not have.
ALTER TABLE "PayPayout" ADD CONSTRAINT "PayPayout_reversal_cash_check"
    CHECK (
      ("reversalCashMovementId" IS NOT NULL)
      = ("reversedAt" IS NOT NULL AND "method" = 'CASH')
    );
