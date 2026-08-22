<script setup lang="ts">
import type { SaleReceipt } from '@huta/shared/schemas'
import type { HTMLAttributes } from 'vue'
import {
  STATUS_BADGE,
  lineName,
  money,
  quantityWithUnit,
  rateLabel,
  refundStatusNote,
  saleNumber,
  taxLabel,
} from '~/lib/sale-format'
import { cn } from '~/lib/utils'

/**
 * A past sale as the COUNTER reads it (Kasan's H2 pick, 2026-08-21) — items left, money
 * right, sized for a 1080p touchscreen at arm's length.
 *
 * The third sibling: `SalesReceipt` is the slip a customer would recognise (checkout),
 * `SalesReceiptRecord` is the back office's audit record, and this is the register's
 * lookup. Same facts, three jobs, three layouts — a single component with three modes would
 * be a component with three sets of layout opinions leaking upward.
 *
 * The money panel is deliberately the same width and position as the cart panel on
 * `/register/sale`, so staff look for a total in the place they already use all day. Type
 * is a step up throughout, because the back-office `text-sm` was being read across a
 * counter rather than at 60cm.
 *
 * Actions are NOT here — the page owns them, because Return and Void navigate to
 * `/register/return`, which owns the refund composer and the manager-approval overlay.
 */
const props = defineProps<{
  receipt: SaleReceipt
  class?: HTMLAttributes['class']
}>()

const when = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const badge = computed(() => STATUS_BADGE[props.receipt.status] ?? null)

/** Only refunds that actually moved money. A FAILED one is shown but never counted. */
const settledRefunds = computed(() =>
  props.receipt.refunds.filter((r) => r.status !== 'FAILED'),
)
</script>

<template>
  <div :class="cn('flex min-h-0 flex-1 flex-col p-4', props.class)">
    <!-- ————— who and when ————— -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2.5">
        <h1 class="text-2xl font-extrabold tracking-tight">
          Sale {{ saleNumber(receipt.number) }}
        </h1>
        <span
          v-if="badge"
          class="rounded-full px-2.5 py-1 text-[11px] font-bold"
          :class="badge.class"
        >
          {{ badge.label }}
        </span>
      </div>
      <span class="text-sm text-muted-foreground">
        {{ when.format(new Date(receipt.createdAt)) }} · {{ receipt.cashierName }}
      </span>
    </div>

    <p
      v-if="receipt.status === 'VOIDED' && receipt.voidReason"
      class="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
    >
      <span class="font-bold">Voided.</span> {{ receipt.voidReason }}
    </p>

    <!--
      The split. The money column is fixed at 340px — the cart panel's width on the sale
      screen — so the total lands where staff already look for one.
    -->
    <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <!-- ————— items ————— -->
      <div class="flex flex-col gap-2">
        <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          {{ receipt.lines.length }} {{ receipt.lines.length === 1 ? 'item' : 'items' }}
        </span>
        <div class="flex flex-col gap-2 overflow-y-auto">
          <div
            v-for="line in receipt.lines"
            :key="line.id"
            class="rounded-xl border bg-card px-4 py-3"
          >
            <div class="flex justify-between gap-3">
              <div class="flex min-w-0 flex-col">
                <span class="truncate text-base font-semibold">{{ lineName(line) }}</span>
                <span class="text-sm tabular-nums text-muted-foreground">
                  {{ quantityWithUnit(line.quantityBase, line.trackingMode) }}
                  <template v-if="rateLabel(line.pricePerGramCents)">
                    · {{ rateLabel(line.pricePerGramCents) }}
                  </template>
                </span>
                <span
                  v-for="promo in line.promotions"
                  :key="promo.promotionId"
                  class="text-sm text-primary"
                >
                  {{ promo.nameSnapshot }} −{{ money(promo.discountCents) }}
                </span>
                <span
                  v-if="line.refundedQuantityBase > 0"
                  class="text-sm text-amber-600 dark:text-amber-500"
                >
                  {{ quantityWithUnit(line.refundedQuantityBase, line.trackingMode) }} given back
                </span>
              </div>
              <span class="text-base font-semibold tabular-nums">
                {{ money(line.netCents) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ————— money ————— -->
      <div class="flex flex-col gap-2">
        <div class="rounded-xl border bg-card p-4">
          <div class="flex justify-between text-sm text-muted-foreground">
            <span>Subtotal</span><span class="tabular-nums">{{ money(receipt.subtotalCents) }}</span>
          </div>
          <div
            v-if="receipt.discountCents > 0"
            class="mt-1 flex justify-between text-sm text-muted-foreground"
          >
            <span>Discount</span>
            <span class="tabular-nums">−{{ money(receipt.discountCents) }}</span>
          </div>
          <div class="mt-1 flex justify-between text-sm text-muted-foreground">
            <span>Tax {{ taxLabel(receipt.taxRateBps) }}</span>
            <span class="tabular-nums">{{ money(receipt.taxCents) }}</span>
          </div>

          <!-- the number the customer is pointing at -->
          <div class="my-3 flex flex-col items-end border-y py-3">
            <span class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Total
            </span>
            <span class="text-3xl font-extrabold tracking-tight tabular-nums">
              {{ money(receipt.totalCents) }}
            </span>
          </div>

          <template v-for="(payment, i) in receipt.payments" :key="i">
            <template v-if="payment.method === 'CASH'">
              <div class="flex justify-between text-sm text-muted-foreground">
                <span>Cash</span>
                <span class="tabular-nums">{{ money(payment.cashTenderedCents) }}</span>
              </div>
              <div
                v-if="payment.cashChangeCents > 0"
                class="flex justify-between text-sm font-semibold text-primary"
              >
                <span>Change</span>
                <span class="tabular-nums">{{ money(payment.cashChangeCents) }}</span>
              </div>
            </template>
            <div v-else class="flex justify-between text-sm text-muted-foreground">
              <span>
                {{ payment.cardBrand ? payment.cardBrand.toUpperCase() : 'Card'
                }}{{ payment.cardLast4 ? ` ····${payment.cardLast4}` : '' }}
              </span>
              <span class="tabular-nums">{{ money(payment.amountCents) }}</span>
            </div>
          </template>
        </div>

        <!--
          Money that went back gets its own tinted card — it is a later event with its own
          actor and approver, not another way of paying.
        -->
        <div
          v-if="receipt.refunds.length"
          class="rounded-xl border border-destructive/30 bg-destructive/[0.08] px-4 py-3"
        >
          <div v-for="refund in receipt.refunds" :key="refund.id" class="flex flex-col">
            <div class="flex justify-between gap-3">
              <span class="font-bold">
                ↩ {{ refund.method === 'CASH' ? 'Cash back' : 'Back to card' }}
              </span>
              <span
                class="font-extrabold tabular-nums"
                :class="refund.status === 'FAILED'
                  ? 'text-muted-foreground line-through'
                  : 'text-destructive'"
              >
                −{{ money(refund.amountCents) }}
              </span>
            </div>
            <span v-if="refundStatusNote(refund.status)" class="text-xs text-muted-foreground">
              {{ refundStatusNote(refund.status) }} — the restock still stands
            </span>
            <span v-if="refund.lines.length" class="text-xs text-muted-foreground">
              <template v-for="(rl, i) in refund.lines" :key="rl.saleLineId">
                <template v-if="i"> · </template>
                {{ quantityWithUnit(rl.quantityBase, rl.trackingMode) }}
                {{ rl.restock ? 'restocked' : 'not restocked' }}
              </template>
            </span>
            <!-- The people on their own line: at 340px an approver's name breaks mid-word
                 when it trails the restock note. -->
            <span class="text-xs text-muted-foreground">
              {{ refund.refundedByName }}
              <template v-if="refund.approvedByName">
                · approved by
                <span class="font-medium text-foreground">{{ refund.approvedByName }}</span>
              </template>
            </span>
          </div>

          <div
            v-if="settledRefunds.length"
            class="mt-2.5 flex justify-between border-t pt-2.5"
          >
            <span class="text-xs text-muted-foreground">Stands</span>
            <span class="font-bold tabular-nums">
              {{ money(receipt.totalCents - settledRefunds.reduce((s, r) => s + r.amountCents, 0)) }}
            </span>
          </div>
        </div>

        <p v-if="receipt.ageVerified" class="px-1 text-xs text-muted-foreground">
          21+ verified by {{ receipt.cashierName }}
        </p>
      </div>
    </div>
  </div>
</template>
