-- Invariants Prisma's schema language cannot express. These are the rules that keep
-- money and stock honest, so they belong in the database rather than only in service
-- code — a bad migration, a manual psql session, or a future bug should all bounce off
-- them.

-- ---------------------------------------------------------------------------
-- Users: STAFF are scoped to exactly one store, ADMINs to none.
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD CONSTRAINT "User_role_store_scope_check"
  CHECK (
    ("role" = 'STAFF' AND "storeId" IS NOT NULL)
    OR ("role" = 'ADMIN' AND "storeId" IS NULL)
  );

-- A staff member with a PIN hash must have the deterministic lookup value too,
-- otherwise the PIN can never be found at the register.
ALTER TABLE "User" ADD CONSTRAINT "User_pin_pairing_check"
  CHECK (("pinHash" IS NULL) = ("pinLookup" IS NULL));

-- ---------------------------------------------------------------------------
-- Variants: EACH prices per item, WEIGHT prices through a price group. Never both.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_pricing_mode_check"
  CHECK (
    ("trackingMode" = 'EACH' AND "priceCents" IS NOT NULL AND "priceGroupId" IS NULL)
    OR ("trackingMode" = 'WEIGHT' AND "priceGroupId" IS NOT NULL AND "priceCents" IS NULL)
  );

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_nonnegative_money_check"
  CHECK (
    ("priceCents" IS NULL OR "priceCents" >= 0)
    AND ("costCents" IS NULL OR "costCents" >= 0)
  );

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_sale_bounds_check"
  CHECK (
    ("minSaleBase" IS NULL OR "minSaleBase" > 0)
    AND ("maxSaleBase" IS NULL OR "maxSaleBase" > 0)
    AND ("minSaleBase" IS NULL OR "maxSaleBase" IS NULL OR "minSaleBase" <= "maxSaleBase")
  );

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------
ALTER TABLE "PriceGroup" ADD CONSTRAINT "PriceGroup_base_rate_check"
  CHECK ("basePricePerGramCents" >= 0);

ALTER TABLE "PriceTier" ADD CONSTRAINT "PriceTier_values_check"
  CHECK ("minQuantityBase" > 0 AND "totalPriceCents" >= 0);

-- Exactly one scope FK is set, and it is the one scopeType names.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_scope_check"
  CHECK (
    (
      ("variantId"    IS NOT NULL)::int
    + ("productId"    IS NOT NULL)::int
    + ("categoryId"   IS NOT NULL)::int
    + ("priceGroupId" IS NOT NULL)::int
    ) = 1
    AND CASE "scopeType"
      WHEN 'VARIANT'     THEN "variantId"    IS NOT NULL
      WHEN 'PRODUCT'     THEN "productId"    IS NOT NULL
      WHEN 'CATEGORY'    THEN "categoryId"   IS NOT NULL
      WHEN 'PRICE_GROUP' THEN "priceGroupId" IS NOT NULL
    END
  );

ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_window_check"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_value_check"
  CHECK (
    "value" >= 0
    AND ("discountType" <> 'PERCENT_OFF' OR "value" <= 10000)
  );

-- ---------------------------------------------------------------------------
-- Inventory: on-hand stock can never go negative. This is the backstop behind the
-- inventory service's own check — an oversell should fail loudly at the DB, not
-- quietly leave a store at -3 grams.
-- ---------------------------------------------------------------------------
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_nonnegative_check"
  CHECK ("quantityBase" >= 0 AND ("reorderPointBase" IS NULL OR "reorderPointBase" >= 0));

-- A movement of zero is meaningless and usually indicates a bug upstream.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_nonzero_check"
  CHECK ("quantityBase" <> 0);

-- Movement direction must match its type. Catches a sign-flip bug at the boundary
-- rather than three months later during a stock count.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_direction_check"
  CHECK (
    CASE "type"
      WHEN 'SALE'         THEN "quantityBase" < 0
      WHEN 'TRANSFER_OUT' THEN "quantityBase" < 0
      WHEN 'SHRINKAGE'    THEN "quantityBase" < 0
      WHEN 'RETURN'       THEN "quantityBase" > 0
      WHEN 'TRANSFER_IN'  THEN "quantityBase" > 0
      WHEN 'RECEIVE'      THEN "quantityBase" > 0
      WHEN 'ADJUSTMENT'   THEN TRUE
    END
  );

ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_balance_check"
  CHECK ("balanceAfterBase" >= 0);

-- ---------------------------------------------------------------------------
-- Transfers, orders, receiving
-- ---------------------------------------------------------------------------
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_distinct_stores_check"
  CHECK ("requestingStoreId" <> "sourceStoreId");

ALTER TABLE "TransferRequestLine" ADD CONSTRAINT "TransferRequestLine_quantities_check"
  CHECK (
    "quantityRequestedBase" > 0
    AND ("quantityApprovedBase" IS NULL OR "quantityApprovedBase" >= 0)
    AND ("quantityReceivedBase" IS NULL OR "quantityReceivedBase" >= 0)
  );

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_values_check"
  CHECK ("quantityBase" > 0 AND ("unitCostCents" IS NULL OR "unitCostCents" >= 0));

ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_values_check"
  CHECK ("quantityBase" > 0 AND ("unitCostCents" IS NULL OR "unitCostCents" >= 0));

-- ---------------------------------------------------------------------------
-- Sales: the line arithmetic must hold. netCents = grossCents - discountCents is the
-- single most load-bearing equation in the system.
-- ---------------------------------------------------------------------------
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_quantity_check"
  CHECK ("quantityBase" > 0);

ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_rate_mode_check"
  CHECK (
    ("trackingMode" = 'EACH' AND "unitPriceCents" IS NOT NULL AND "pricePerGramCents" IS NULL)
    OR ("trackingMode" = 'WEIGHT' AND "pricePerGramCents" IS NOT NULL AND "unitPriceCents" IS NULL)
  );

ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_arithmetic_check"
  CHECK (
    "grossCents" >= 0
    AND "discountCents" >= 0
    AND "taxCents" >= 0
    AND "discountCents" <= "grossCents"
    AND "netCents" = "grossCents" - "discountCents"
  );

ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_refunded_quantity_check"
  CHECK ("refundedQuantityBase" >= 0 AND "refundedQuantityBase" <= "quantityBase");

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_arithmetic_check"
  CHECK (
    "subtotalCents" >= 0
    AND "discountCents" >= 0
    AND "taxCents" >= 0
    AND "taxRateBps" >= 0
    AND "totalCents" = "subtotalCents" - "discountCents" + "taxCents"
  );

-- An age-verified sale must record who verified it. The compliance record is the
-- person, not the checkbox.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_age_verification_check"
  CHECK ("ageVerified" = FALSE OR "ageVerifiedById" IS NOT NULL);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check"
  CHECK ("amountCents" > 0);

-- Cash payments carry tender/change; card payments carry a PaymentIntent.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_method_fields_check"
  CHECK (
    ("method" = 'CASH' AND "stripePaymentIntentId" IS NULL)
    OR ("method" = 'CARD' AND "cashTenderedCents" IS NULL AND "cashChangeCents" IS NULL)
  );

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cash_tender_check"
  CHECK (
    "cashTenderedCents" IS NULL
    OR ("cashTenderedCents" >= 0 AND COALESCE("cashChangeCents", 0) >= 0)
  );

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check"
  CHECK ("amountCents" > 0);

ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_values_check"
  CHECK ("quantityBase" > 0 AND "amountCents" >= 0);

-- ---------------------------------------------------------------------------
-- Shifts and cash
-- ---------------------------------------------------------------------------
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_opening_cash_check"
  CHECK ("openingCashCents" >= 0);

-- A closed shift must be fully reconciled; an open one must not be.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_closure_check"
  CHECK (
    ("status" = 'OPEN'
      AND "closedAt" IS NULL
      AND "closingCountedCashCents" IS NULL
      AND "varianceCents" IS NULL)
    OR ("status" = 'CLOSED'
      AND "closedAt" IS NOT NULL
      AND "closingCountedCashCents" IS NOT NULL
      AND "expectedCashCents" IS NOT NULL
      AND "varianceCents" IS NOT NULL)
  );

ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_check"
  CHECK ("amountCents" > 0);

-- ---------------------------------------------------------------------------
-- Loyalty
-- ---------------------------------------------------------------------------
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_nonnegative_check"
  CHECK ("pointsBalance" >= 0 AND "storeCreditCents" >= 0);

-- ---------------------------------------------------------------------------
-- Stores
-- ---------------------------------------------------------------------------
ALTER TABLE "Store" ADD CONSTRAINT "Store_tax_rate_check"
  CHECK ("taxRateBps" >= 0 AND "taxRateBps" <= 10000);

-- ---------------------------------------------------------------------------
-- Potency: populate mg per unit (packaged goods) or percentage (flower), not neither.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProductCannabinoid" ADD CONSTRAINT "ProductCannabinoid_potency_check"
  CHECK (
    ("mgPerUnit" IS NOT NULL OR "percentBps" IS NOT NULL)
    AND ("mgPerUnit" IS NULL OR "mgPerUnit" >= 0)
    AND ("percentBps" IS NULL OR ("percentBps" >= 0 AND "percentBps" <= 10000))
  );
