-- Per-category fallback reorder point, in BASE UNITS.
--
-- Every StockLevel."reorderPointBase" in the database is null, so "below reorder" had no
-- threshold to compare against and the UI fell back to a hardcoded `quantityBase <= 3`.
-- That is wrong for WEIGHT variants, whose base unit is a milligram: flower only turned
-- amber at 3mg, by which point it is dust.
--
-- Resolution order is StockLevel."reorderPointBase" -> Category."defaultReorderBase" ->
-- null, and null means the variant can only ever be OUT, never LOW.
ALTER TABLE "Category" ADD COLUMN "defaultReorderBase" INTEGER;

-- Same backstop discipline as the other 40 CHECKs: a negative reorder point would make
-- LOW unreachable in a way that looks like healthy stock rather than like a bad row.
ALTER TABLE "Category"
  ADD CONSTRAINT "category_default_reorder_nonneg"
  CHECK ("defaultReorderBase" IS NULL OR "defaultReorderBase" >= 0);
