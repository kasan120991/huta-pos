-- The drawer review record: why a variance happened, written by an admin after the close.
--
-- Separate from `Shift.notes`, which is what the cashier typed while counting. A manager's
-- conclusion must not overwrite the more direct account of the two.

ALTER TABLE "Shift" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "Shift" ADD COLUMN "reviewedAt"   TIMESTAMP(3);
ALTER TABLE "Shift" ADD COLUMN "reviewNote"   TEXT;

ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The review queue: off and not yet explained.
CREATE INDEX "Shift_varianceCents_reviewedAt_idx" ON "Shift"("varianceCents", "reviewedAt");

-- Never half a review record. The reviewer and the timestamp are written together or not
-- at all, the same pairing rule `Receipt` already carries for its sign-off.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_review_pairing_check"
  CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

-- No explanation without someone who stands behind it. An unattributed note on a cash
-- variance is worse than none: it reads as a finding while naming nobody.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_review_note_check"
  CHECK ("reviewNote" IS NULL OR "reviewedById" IS NOT NULL);

-- An OPEN drawer has nothing to explain — it has no counted figure and therefore no
-- variance, which the existing close CHECKs already guarantee.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_review_closed_check"
  CHECK ("reviewedAt" IS NULL OR "status" = 'CLOSED');
