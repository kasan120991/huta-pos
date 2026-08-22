<script setup lang="ts">
import type { SaleReceipt } from '@huta/shared/schemas'
import type { HTMLAttributes } from 'vue'
import {
  lineName,
  money as fmt,
  quantity as qty,
  quantityWithUnit,
  rateLabel,
  refundStatusNote,
  taxLabel,
} from '~/lib/sale-format'
import { cn } from '~/lib/utils'

/**
 * The sales receipt, rendered from the server's snapshot and nothing else.
 *
 * Extracted from the sale workstation's completion dialog, which was the only complete
 * renderer in the app — three surfaces need it now (checkout, the register's history, the
 * back office), and three copies of a receipt is three ways for the same sale to read
 * differently.
 *
 * Every figure here is a SNAPSHOT taken at checkout: the price, the tier, the promo names,
 * the tax rate. Nothing joins to current catalog state, so a receipt still explains itself
 * after a price change — see the header of shared/src/schemas/sales.ts.
 *
 * Composition only: no dialog, no fetching, no actions. Whoever mounts it owns the chrome
 * and the buttons, which is what lets the same block sit in a dialog, a Sheet and a pane.
 *
 * NOTE the file name. Nuxt's path-prefixed auto-import registers this as `SalesReceipt`;
 * a component under `sales/` whose name doesn't lead with the directory silently renders
 * nothing, and "Failed to resolve component" is only a console WARNING.
 */
const props = defineProps<{
  receipt: SaleReceipt
  /** Header line (store · cashier · time). Off when the parent already says it. */
  showHeader?: boolean
  class?: HTMLAttributes['class']
}>()

const when = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
</script>

<template>
  <div :class="cn('flex flex-col gap-2 text-sm', props.class)">
    <p v-if="showHeader" class="text-xs text-muted-foreground">
      {{ receipt.storeName }} · {{ receipt.cashierName }} ·
      {{ when.format(new Date(receipt.createdAt)) }}
    </p>

    <div
      v-if="receipt.status === 'VOIDED'"
      class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive"
    >
      VOIDED<template v-if="receipt.voidReason"> — {{ receipt.voidReason }}</template>
    </div>

    <div class="flex flex-col gap-1.5">
      <div v-for="line in receipt.lines" :key="line.id" class="flex flex-col">
        <div class="flex justify-between gap-3">
          <span class="min-w-0 flex-1 truncate">
            {{ lineName(line) }}
            <span class="text-xs text-muted-foreground">
              · {{ qty(line.quantityBase, line.trackingMode) }}
            </span>
          </span>
          <span class="tabular-nums">{{ fmt(line.netCents) }}</span>
        </div>
        <!--
          The rate that priced a weight line, as a DESCRIPTION of the charge — never its
          input. extendTier charges the typed total at a threshold and floors just above it,
          so rate × quantity does not reproduce this total on most tiers.
        -->
        <span v-if="rateLabel(line.pricePerGramCents)" class="text-xs text-muted-foreground">
          {{ rateLabel(line.pricePerGramCents) }}
        </span>
        <!-- Promotions are a LIST: best-outcome stacking can apply several to one line,
             and each carries its own snapshotted name and discount. -->
        <span
          v-for="promo in line.promotions"
          :key="promo.promotionId"
          class="text-xs text-primary"
        >
          {{ promo.nameSnapshot }} −{{ fmt(promo.discountCents) }}
        </span>
        <span
          v-if="line.refundedQuantityBase > 0"
          class="text-xs text-amber-600 dark:text-amber-500"
        >
          {{ quantityWithUnit(line.refundedQuantityBase, line.trackingMode) }} given back
        </span>
      </div>
    </div>

    <div class="mt-1 flex flex-col gap-1 border-t pt-2">
      <div class="flex justify-between text-muted-foreground">
        <span>Subtotal</span><span class="tabular-nums">{{ fmt(receipt.subtotalCents) }}</span>
      </div>
      <div v-if="receipt.discountCents > 0" class="flex justify-between text-muted-foreground">
        <span>Discount</span><span class="tabular-nums">−{{ fmt(receipt.discountCents) }}</span>
      </div>
      <div class="flex justify-between text-muted-foreground">
        <span>Tax {{ taxLabel(receipt.taxRateBps) }}</span><span class="tabular-nums">{{ fmt(receipt.taxCents) }}</span>
      </div>
      <div class="flex justify-between text-base font-bold">
        <span>Total</span><span class="tabular-nums">{{ fmt(receipt.totalCents) }}</span>
      </div>

      <!-- The payments ARRAY — a split tender is two rows, and cash gives no change in one. -->
      <template v-for="(payment, i) in receipt.payments" :key="i">
        <template v-if="payment.method === 'CASH'">
          <div class="flex justify-between text-muted-foreground">
            <span>Cash</span><span class="tabular-nums">{{ fmt(payment.cashTenderedCents) }}</span>
          </div>
          <div
            v-if="payment.cashChangeCents > 0"
            class="flex justify-between font-semibold text-primary"
          >
            <span>Change</span><span class="tabular-nums">{{ fmt(payment.cashChangeCents) }}</span>
          </div>
        </template>
        <div v-else class="flex justify-between text-muted-foreground">
          <span>
            {{ payment.cardBrand ? payment.cardBrand.toUpperCase() : 'Card'
            }}{{ payment.cardLast4 ? ` ····${payment.cardLast4}` : '' }}
          </span>
          <span class="tabular-nums">{{ fmt(payment.amountCents) }}</span>
        </div>
      </template>

    </div>

    <!--
      Refunds sit OUTSIDE the tender stack. A refund is not a way of paying — it is a later
      event with its own actor and, since Phase 9, its own admin approver. Listing it beside
      "Cash $31.20" hid all of that and read as though money going back were a tender.
    -->
    <div v-if="receipt.refunds.length" class="mt-1 flex flex-col gap-1.5 border-t pt-2">
      <div
        v-for="refund in receipt.refunds"
        :key="refund.id"
        class="flex flex-col"
      >
        <div class="flex justify-between">
          <span :class="refund.status === 'FAILED' ? 'text-muted-foreground' : 'text-destructive'">
            ↩ {{ refund.method === 'CASH' ? 'Cash back' : 'Back to card' }}
          </span>
          <span
            class="tabular-nums"
            :class="refund.status === 'FAILED'
              ? 'text-muted-foreground line-through'
              : 'text-destructive'"
          >
            −{{ fmt(refund.amountCents) }}
          </span>
        </div>
        <span v-if="refundStatusNote(refund.status)" class="text-xs text-muted-foreground">
          {{ refundStatusNote(refund.status) }} — the restock still stands
        </span>
        <span class="text-xs text-muted-foreground">
          {{ refund.refundedByName }}
          <template v-if="refund.approvedByName">
            · approved by {{ refund.approvedByName }}
          </template>
        </span>
      </div>
    </div>

    <p v-if="receipt.ageVerified" class="text-xs text-muted-foreground">
      21+ verified by {{ receipt.cashierName }}.
    </p>
  </div>
</template>
