<script setup lang="ts">
import type { SaleReceipt } from '@huta/shared/schemas'
import type { HTMLAttributes } from 'vue'
import {
  STATUS_BADGE,
  lineName,
  money,
  quantity,
  quantityWithUnit,
  rateLabel,
  refundStatusNote,
  saleNumber,
  taxLabel,
} from '~/lib/sale-format'
import { cn } from '~/lib/utils'

/**
 * The back office's view of a sale (Kasan's D1 pick, 2026-08-21) — an audit record in
 * labelled sections, not the slip.
 *
 * Distinct from `SalesReceipt` on purpose rather than a `variant` prop on it: the counter
 * wants the slip a customer would recognise, and the back office wants to know who approved
 * what. One component with two layout modes ends up with layout opinions leaking upward
 * from both call sites.
 *
 * What this fixes about the first pass, all found by driving it against real sales:
 *
 *   * **Refunds leave the tender stack.** A refund is not a way of paying — it is a later
 *     event with its own actor, its own time and, since Phase 9, its own APPROVER. That
 *     two-person record was the thing the old drawer hid completely.
 *   * **The store is in the header.** Sale numbers are per store (`@@unique([storeId,
 *     number])`), so there are two #0002s and the number alone identifies nothing.
 *   * **The rate is rendered**, so "why was 3.50 g $30.00?" is answerable on screen.
 *   * **Sections are conditional.** A plain cash sale collapses to Items / Money / Paid;
 *     the audit chrome only appears when there is something to explain.
 */
const props = defineProps<{
  receipt: SaleReceipt
  class?: HTMLAttributes['class']
}>()

const when = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
const timeOnly = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

/** Refunds that actually moved money. A FAILED one is shown but must not be counted. */
const settledRefunds = computed(() =>
  props.receipt.refunds.filter((r) => r.status !== 'FAILED'),
)

const refundedCents = computed(() =>
  settledRefunds.value.reduce((sum, r) => sum + r.amountCents, 0),
)

/** What the shop actually kept — the figure this drawer is usually opened for. */
const keptCents = computed(() => props.receipt.totalCents - refundedCents.value)

const badge = computed(() => STATUS_BADGE[props.receipt.status] ?? null)

/**
 * A refund can land on a different DAY from its sale — `Refund.shiftId` is the refund's
 * drawer, not the sale's — so the date is spelled out when it differs and the time alone
 * shown when it does not.
 */
function refundWhen(iso: string): string {
  const at = new Date(iso)
  const sameDay = at.toDateString() === new Date(props.receipt.createdAt).toDateString()
  return sameDay ? timeOnly.format(at) : when.format(at)
}
</script>

<template>
  <div :class="cn('flex flex-col text-sm', props.class)">
    <!--
      ————— who, where, when —————
      pr-12 keeps the status badge clear of the Sheet's own close button, which is absolutely
      positioned at the top-right of the panel and would otherwise sit on top of it.
    -->
    <section class="px-4 py-3 pr-12">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-bold">Sale {{ saleNumber(receipt.number) }}</h2>
          <p class="truncate text-xs text-muted-foreground">
            {{ receipt.storeName }}
          </p>
        </div>
        <span
          v-if="badge"
          class="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold"
          :class="badge.class"
        >
          {{ badge.label }}
        </span>
      </div>
      <p class="mt-1.5 text-xs text-muted-foreground">
        {{ when.format(new Date(receipt.createdAt)) }} · rung by {{ receipt.cashierName }}
      </p>

      <p
        v-if="receipt.status === 'VOIDED' && receipt.voidReason"
        class="mt-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <span class="font-bold">Voided.</span> {{ receipt.voidReason }}
      </p>
    </section>

    <!-- ————— items ————— -->
    <section class="border-t px-4 py-3">
      <h3 class="mb-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {{ receipt.lines.length }} {{ receipt.lines.length === 1 ? 'item' : 'items' }}
      </h3>
      <div class="flex flex-col gap-2.5">
        <div v-for="line in receipt.lines" :key="line.id" class="flex flex-col">
          <div class="flex justify-between gap-3">
            <span class="min-w-0 flex-1 truncate">{{ lineName(line) }}</span>
            <span class="tabular-nums">{{ money(line.netCents) }}</span>
          </div>

          <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span class="text-xs tabular-nums text-muted-foreground">
              {{ quantityWithUnit(line.quantityBase, line.trackingMode) }}
            </span>
            <!--
              The RATE, as a description of the charge — never its input. extendTier charges
              the typed total at a threshold and floors just above it, so rate × quantity
              does not reproduce this line's total on most tiers.
            -->
            <span
              v-if="rateLabel(line.pricePerGramCents)"
              class="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary"
            >
              {{ rateLabel(line.pricePerGramCents) }}
            </span>
          </div>

          <span
            v-for="promo in line.promotions"
            :key="promo.promotionId"
            class="text-xs text-primary"
          >
            {{ promo.nameSnapshot }} −{{ money(promo.discountCents) }}
          </span>

          <span
            v-if="line.refundedQuantityBase > 0"
            class="mt-0.5 text-xs text-amber-600 dark:text-amber-500"
          >
            {{ quantityWithUnit(line.refundedQuantityBase, line.trackingMode) }} given back
          </span>
        </div>
      </div>
    </section>

    <!-- ————— money ————— -->
    <section class="border-t px-4 py-3">
      <h3 class="mb-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        Money
      </h3>
      <dl class="flex flex-col gap-1">
        <div class="flex justify-between text-muted-foreground">
          <dt>Subtotal</dt>
          <dd class="tabular-nums">{{ money(receipt.subtotalCents) }}</dd>
        </div>
        <div v-if="receipt.discountCents > 0" class="flex justify-between text-muted-foreground">
          <dt>Discount</dt>
          <dd class="tabular-nums">−{{ money(receipt.discountCents) }}</dd>
        </div>
        <div class="flex justify-between text-muted-foreground">
          <dt>Tax {{ taxLabel(receipt.taxRateBps) }}</dt>
          <dd class="tabular-nums">{{ money(receipt.taxCents) }}</dd>
        </div>
        <div class="flex justify-between text-base font-bold">
          <dt>Total</dt>
          <dd class="tabular-nums">{{ money(receipt.totalCents) }}</dd>
        </div>
      </dl>
    </section>

    <!-- ————— tender ————— -->
    <section v-if="receipt.payments.length" class="border-t px-4 py-3">
      <h3 class="mb-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        Paid
      </h3>
      <dl class="flex flex-col gap-1">
        <template v-for="(payment, i) in receipt.payments" :key="i">
          <template v-if="payment.method === 'CASH'">
            <div class="flex justify-between text-muted-foreground">
              <dt>Cash tendered</dt>
              <dd class="tabular-nums">{{ money(payment.cashTenderedCents) }}</dd>
            </div>
            <div v-if="payment.cashChangeCents > 0" class="flex justify-between">
              <dt class="text-muted-foreground">Change</dt>
              <dd class="font-semibold tabular-nums text-primary">
                {{ money(payment.cashChangeCents) }}
              </dd>
            </div>
          </template>
          <div v-else class="flex justify-between text-muted-foreground">
            <dt>
              {{ payment.cardBrand ? payment.cardBrand.toUpperCase() : 'Card'
              }}{{ payment.cardLast4 ? ` ····${payment.cardLast4}` : '' }}
            </dt>
            <dd class="tabular-nums">{{ money(payment.amountCents) }}</dd>
          </div>
        </template>
      </dl>
    </section>

    <!--
      ————— given back —————
      Its own block, tinted, with the PEOPLE attached. A refund is a separate event from the
      sale: a different actor, a later time, possibly a different drawer, and since Phase 9
      always an admin approver. Rendering it as another tender line hid all of that.
    -->
    <section
      v-if="receipt.refunds.length"
      class="border-t bg-destructive/[0.06] px-4 py-3"
    >
      <h3 class="mb-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-destructive">
        Given back
      </h3>
      <div class="flex flex-col gap-3">
        <div v-for="refund in receipt.refunds" :key="refund.id" class="flex flex-col">
          <div class="flex justify-between gap-3">
            <span class="font-medium">
              {{ refund.method === 'CASH' ? 'Cash' : 'Back to card' }}
            </span>
            <span
              class="font-bold tabular-nums"
              :class="refund.status === 'FAILED' ? 'text-muted-foreground line-through' : 'text-destructive'"
            >
              −{{ money(refund.amountCents) }}
            </span>
          </div>

          <p v-if="refundStatusNote(refund.status)" class="text-xs font-semibold text-muted-foreground">
            {{ refundStatusNote(refund.status) }} — the restock still stands
          </p>

          <p v-if="refund.lines.length" class="text-xs text-muted-foreground">
            <template v-for="(rl, i) in refund.lines" :key="rl.saleLineId">
              <template v-if="i"> · </template>
              {{ quantityWithUnit(rl.quantityBase, rl.trackingMode) }}
              {{ rl.restock ? 'restocked' : 'not restocked' }}
            </template>
          </p>

          <p class="text-xs text-muted-foreground">
            {{ refundWhen(refund.createdAt) }} · {{ refund.refundedByName }}
            <template v-if="refund.approvedByName">
              · approved by
              <span class="font-medium text-foreground">{{ refund.approvedByName }}</span>
            </template>
          </p>

          <p v-if="refund.reason" class="text-xs italic text-muted-foreground">
            “{{ refund.reason }}”
          </p>
        </div>

        <div class="flex justify-between border-t pt-2">
          <span class="text-xs text-muted-foreground">Kept</span>
          <span class="font-bold tabular-nums">{{ money(keptCents) }}</span>
        </div>
      </div>
    </section>

    <!-- ————— compliance ————— -->
    <section v-if="receipt.ageVerified" class="border-t px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary">
          21+
        </span>
        <span class="text-xs text-muted-foreground">
          verified by {{ receipt.cashierName }}
        </span>
      </div>
    </section>
  </div>
</template>
