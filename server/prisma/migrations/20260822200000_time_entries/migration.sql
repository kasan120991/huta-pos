-- The timeclock. A person's working hours, deliberately separate from Shift, which is a
-- per-store cash drawer and says nothing about when an individual was at work.

CREATE TYPE "TimeEntryStatus" AS ENUM ('OPEN', 'CLOCKED', 'AUTO', 'CORRECTED', 'VOIDED');

CREATE TABLE "TimeEntry" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "storeId"              TEXT NOT NULL,
    "clockedInTerminalId"  TEXT,
    "clockedOutTerminalId" TEXT,
    "clockedInAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockedOutAt"         TIMESTAMP(3),
    "status"               "TimeEntryStatus" NOT NULL DEFAULT 'OPEN',
    "closedById"           TEXT,
    "note"                 TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TimeEntry_userId_clockedInAt_idx"  ON "TimeEntry"("userId", "clockedInAt");
CREATE INDEX "TimeEntry_storeId_clockedInAt_idx" ON "TimeEntry"("storeId", "clockedInAt");
CREATE INDEX "TimeEntry_status_idx"              ON "TimeEntry"("status");

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_clockedInTerminalId_fkey"
    FOREIGN KEY ("clockedInTerminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_clockedOutTerminalId_fkey"
    FOREIGN KEY ("clockedOutTerminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_closedById_fkey"
    FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── invariants ───────────────────────────────────────────────────────────────────────────

-- ONE OPEN ENTRY PER PERSON, enforced by the database rather than by a read-then-write.
-- Prisma cannot express a partial unique index, so it is written by hand here — the same
-- reason the 35 CHECKs in the constraints migration are hand-written. Two tills, two taps,
-- one row.
CREATE UNIQUE INDEX "TimeEntry_one_open_per_user"
    ON "TimeEntry"("userId") WHERE "status" = 'OPEN';

-- An entry that ended cannot have ended before it began. Strict '>' because a zero-length
-- entry is nonsense too.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_interval_check"
    CHECK ("clockedOutAt" IS NULL OR "clockedOutAt" > "clockedInAt");

-- Status and the end time agree. OPEN has no end; every closed state has one. This is what
-- stops a row claiming to be finished while carrying no finishing time, which would make
-- every hours total silently wrong rather than loudly broken.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_status_pairing_check"
    CHECK (
      ("status" = 'OPEN'      AND "clockedOutAt" IS NULL)
      OR ("status" = 'VOIDED')
      OR ("status" IN ('CLOCKED', 'AUTO', 'CORRECTED') AND "clockedOutAt" IS NOT NULL)
    );

-- A correction or a void must say why. An altered timesheet without a reason is not an
-- audit trail, and this is the table someone gets paid from.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_reason_check"
    CHECK ("status" NOT IN ('CORRECTED', 'VOIDED') OR "note" IS NOT NULL);
