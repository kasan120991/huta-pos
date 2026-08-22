-- Allow a cannabinoid link to carry no potency figure at all.
--
-- The original constraint required mgPerUnit OR percentBps. That was a design error:
-- "this product contains Delta-8, potency unknown" is a legitimate and extremely common
-- state. The legacy catalog records ~120 products exactly that way, and title-parsing
-- recovers ~78 more, so the old rule would have forced us to either discard the
-- association or invent a potency figure — the second of which records a false fact,
-- since 0mg reads as "contains none".
--
-- The range checks are kept: a potency that IS recorded must still be sane.

ALTER TABLE "ProductCannabinoid" DROP CONSTRAINT "ProductCannabinoid_potency_check";

ALTER TABLE "ProductCannabinoid" ADD CONSTRAINT "ProductCannabinoid_potency_check"
  CHECK (
    ("mgPerUnit" IS NULL OR "mgPerUnit" >= 0)
    AND ("percentBps" IS NULL OR ("percentBps" >= 0 AND "percentBps" <= 10000))
  );
