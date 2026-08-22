-- Potency sanity for per-variant cannabinoid links.
--
-- Mirrors "ProductCannabinoid_potency_check" exactly, including the relaxation from
-- migration `relax_potency`: BOTH figures may be null, because "contains Delta-8,
-- potency unrecorded" is a legitimate and common fact and inventing a 0 would record
-- a false one (0mg reads as "contains none"). A figure that IS recorded must be sane.
--
-- Prisma's schema language cannot express this, so it lives here as the backstop behind
-- the service layer — same arrangement as the other 52 CHECKs.

ALTER TABLE "VariantCannabinoid" ADD CONSTRAINT "VariantCannabinoid_potency_check"
  CHECK (
    ("mgPerUnit" IS NULL OR "mgPerUnit" >= 0)
    AND ("percentBps" IS NULL OR ("percentBps" >= 0 AND "percentBps" <= 10000))
  );
