<script setup lang="ts">
import type { CashMovementRow, ShiftRow } from '@huta/shared/schemas'
import type { Cents } from '@huta/shared'
import { formatCents, parseDollarsToCents } from '@huta/shared'
import { Spinner } from '~/components/ui/spinner'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * The drawer's day: open with a counted float, move cash with a reason, close
 * COUNTED-FIRST — the drawer total is keyed blind and expected/variance reveal only
 * after, so the count is never steered toward the expected figure.
 */
definePageMeta({ layout: 'register' })

const router = useRouter()
const auth = useAuthStore()

const shift = ref<ShiftRow | null>(null)
const movements = ref<CashMovementRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

/** The just-closed shift, held for the reveal screen. */
const closedShift = ref<ShiftRow | null>(null)

const storeId = computed(() => auth.terminal?.store.id)

async function fetchShift() {
  const data = await apiFetch<{ shift: ShiftRow | null }>('/shifts/current', {
    query: { storeId: storeId.value },
  })
  shift.value = data.shift
  if (data.shift) {
    const m = await apiFetch<{ movements: CashMovementRow[] }>(`/shifts/${data.shift.id}/movements`)
    movements.value = m.movements
  } else {
    movements.value = []
  }
}

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  if (!auth.isAuthenticated) return router.replace('/register/pair')
  if (auth.isUnattendedTerminal) return router.replace('/register/sign-in')
  if (!auth.isAtTerminal) return router.replace('/')
  try {
    await fetchShift()
  } finally {
    loading.value = false
  }
})

function dollars(raw: string): number | null {
  const parsed = parseDollarsToCents(raw.trim())
  return parsed.ok ? parsed.value : null
}

/* ————— open ————— */
const floatStr = ref('')
const opening = ref(false)

async function open() {
  const cents = dollars(floatStr.value)
  if (cents === null || opening.value) return
  opening.value = true
  error.value = null
  try {
    shift.value = await apiFetch<ShiftRow>('/shifts/open', {
      method: 'POST',
      body: { openingCashCents: cents, ...(storeId.value ? { storeId: storeId.value } : {}) },
    })
    floatStr.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    opening.value = false
  }
}

/* ————— cash movements ————— */
const moveOpen = ref(false)
const moveType = ref<'PAID_IN' | 'PAID_OUT' | 'DROP'>('DROP')
const moveAmount = ref('')
const moveReason = ref('')
const moving = ref(false)
const moveError = ref<string | null>(null)

async function submitMovement() {
  const cents = dollars(moveAmount.value)
  if (cents === null || cents <= 0 || !moveReason.value.trim() || moving.value || !shift.value) return
  moving.value = true
  moveError.value = null
  try {
    await apiFetch(`/shifts/${shift.value.id}/movements`, {
      method: 'POST',
      body: { type: moveType.value, amountCents: cents, reason: moveReason.value.trim() },
    })
    moveOpen.value = false
    moveAmount.value = ''
    moveReason.value = ''
    await fetchShift()
  } catch (err) {
    moveError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    moving.value = false
  }
}

/* ————— close (counted-first) ————— */
const closeOpen = ref(false)
const countedStr = ref('')
const closing = ref(false)
const closeError = ref<string | null>(null)

async function submitClose() {
  const cents = dollars(countedStr.value)
  if (cents === null || closing.value || !shift.value) return
  closing.value = true
  closeError.value = null
  try {
    closedShift.value = await apiFetch<ShiftRow>(`/shifts/${shift.value.id}/close`, {
      method: 'POST',
      body: { countedCashCents: cents },
    })
    closeOpen.value = false
    countedStr.value = ''
    shift.value = null
  } catch (err) {
    closeError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    closing.value = false
  }
}

const fmt = (cents: number | null | undefined) => (cents == null ? '—' : formatCents(cents as Cents))
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const movementSum = (type: string) =>
  movements.value.filter((m) => m.type === type).reduce((sum, m) => sum + m.amountCents, 0)

const MOVEMENT_LABEL: Record<string, string> = {
  PAID_IN: 'Paid in',
  PAID_OUT: 'Paid out',
  DROP: 'Safe drop',
}
</script>

<template>
  <div class="flex flex-1 flex-col">
    <RegisterBar />

    <div class="flex min-h-0 flex-1">
    <RegisterRail active="/register/shift" />
    <div class="flex min-w-0 flex-1 items-start justify-center overflow-y-auto p-8">
      <p v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />Loading…
      </p>

      <!-- closed reveal -->
      <div v-else-if="closedShift" class="flex w-full max-w-sm flex-col gap-3 rounded-2xl border bg-card p-5">
        <h1 class="text-lg font-bold tracking-tight">Shift closed</h1>
        <dl class="flex flex-col gap-1.5 text-sm">
          <div class="flex justify-between"><dt class="text-muted-foreground">Opening float</dt><dd class="tabular-nums">{{ fmt(closedShift.openingCashCents) }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted-foreground">Cash sales ({{ closedShift.saleCount }})</dt><dd class="tabular-nums">+{{ fmt(closedShift.cashSalesCents) }}</dd></div>
          <div v-if="closedShift.cashRefundsCents > 0" class="flex justify-between"><dt class="text-muted-foreground">Cash refunds</dt><dd class="tabular-nums text-destructive">−{{ fmt(closedShift.cashRefundsCents) }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted-foreground">Paid in / out</dt><dd class="tabular-nums">+{{ fmt(movementSum('PAID_IN')) }} / −{{ fmt(movementSum('PAID_OUT')) }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted-foreground">Safe drops</dt><dd class="tabular-nums">−{{ fmt(movementSum('DROP')) }}</dd></div>
          <div class="flex justify-between border-t pt-2 font-semibold"><dt>Expected</dt><dd class="tabular-nums">{{ fmt(closedShift.expectedCashCents) }}</dd></div>
          <div class="flex justify-between font-semibold"><dt>You counted</dt><dd class="tabular-nums">{{ fmt(closedShift.closingCountedCashCents) }}</dd></div>
          <div
            class="flex justify-between text-base font-bold"
            :class="(closedShift.varianceCents ?? 0) === 0 ? 'text-primary' : 'text-amber-500'"
          >
            <dt>Variance</dt>
            <dd class="tabular-nums">
              {{ (closedShift.varianceCents ?? 0) >= 0 ? '+' : '−' }}{{ fmt(Math.abs(closedShift.varianceCents ?? 0)) }}
              {{ (closedShift.varianceCents ?? 0) === 0 ? 'exact' : (closedShift.varianceCents ?? 0) < 0 ? 'short' : 'over' }}
            </dd>
          </div>
        </dl>
        <div
          v-if="closedShift.cardSalesCents > 0"
          class="flex items-center justify-between rounded-xl border bg-background/60 px-3 py-2 text-sm"
        >
          <span class="text-muted-foreground">💳 Card sales — settles to the bank, not this drawer</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ fmt(closedShift.cardSalesCents) }}</span>
        </div>
        <p class="text-xs text-muted-foreground">Recorded on the shift — variances are reported, never absorbed.</p>
        <Button class="h-11 text-base" @click="closedShift = null">Done</Button>
      </div>

      <!-- no shift: open form -->
      <div v-else-if="!shift" class="flex w-full max-w-xs flex-col items-center gap-4 text-center">
        <h1 class="text-2xl font-extrabold tracking-tight">Open shift</h1>
        <p class="text-sm text-muted-foreground">Count the opening float in the drawer.</p>
        <!-- h-14 on the GROUP, not the control: InputGroup owns the border and defaults
             to h-8, so sizing the inner input leaves a 56px number in a 32px box. -->
        <InputGroup class="h-14 w-44">
          <InputGroupAddon class="text-lg">$</InputGroupAddon>
          <InputGroupInput
            v-model="floatStr"
            inputmode="decimal"
            autocomplete="off"
            autofocus
            class="text-center text-2xl font-bold tabular-nums"
            aria-label="Opening float in dollars"
            @keydown.enter.prevent="open"
          />
        </InputGroup>
        <FieldError v-if="error">{{ error }}</FieldError>
        <Button size="lg" class="h-12 w-44 text-base font-bold" :disabled="dollars(floatStr) === null || opening" @click="open">
          {{ opening ? 'Opening…' : 'Open shift' }}
        </Button>
      </div>

      <!-- open shift dashboard -->
      <div v-else class="flex w-full max-w-md flex-col gap-4">
        <div class="rounded-2xl border bg-card p-5">
          <div class="flex items-baseline gap-2">
            <h1 class="text-lg font-bold tracking-tight">Shift open</h1>
            <span class="text-xs text-muted-foreground">
              since {{ timeFmt.format(new Date(shift.openedAt)) }} · {{ shift.openedByName }}
            </span>
          </div>
          <dl class="mt-3 flex flex-col gap-1.5 text-sm">
            <div class="flex justify-between"><dt class="text-muted-foreground">Opening float</dt><dd class="tabular-nums">{{ fmt(shift.openingCashCents) }}</dd></div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">Sales so far</dt>
              <dd class="tabular-nums">
                {{ shift.saleCount }} · {{ fmt(shift.cashSalesCents) }} cash<template v-if="shift.cardSalesCents > 0"> · {{ fmt(shift.cardSalesCents) }} card</template>
              </dd>
            </div>
            <div v-if="shift.cashRefundsCents > 0" class="flex justify-between">
              <dt class="text-muted-foreground">Cash refunds</dt>
              <dd class="tabular-nums text-destructive">−{{ fmt(shift.cashRefundsCents) }}</dd>
            </div>
          </dl>
        </div>

        <div v-if="movements.length" class="rounded-2xl border bg-card p-4">
          <h2 class="mb-2 text-sm font-semibold">Cash movements</h2>
          <div class="flex flex-col gap-1.5 text-sm">
            <div v-for="m in movements" :key="m.id" class="flex items-center justify-between gap-3">
              <span class="min-w-0 truncate text-muted-foreground">
                {{ MOVEMENT_LABEL[m.type] }} · {{ m.reason }} · {{ m.userName }}
              </span>
              <span class="shrink-0 tabular-nums" :class="m.type === 'PAID_IN' ? 'text-primary' : ''">
                {{ m.type === 'PAID_IN' ? '+' : '−' }}{{ fmt(m.amountCents) }}
              </span>
            </div>
          </div>
        </div>

        <div class="flex gap-3">
          <Button variant="outline" class="h-12 flex-1 text-base" @click="moveOpen = true; moveError = null">
            Move cash
          </Button>
          <Button class="h-12 flex-1 text-base font-bold" @click="closeOpen = true; closeError = null">
            Close shift
          </Button>
        </div>
      </div>
    </div>
    </div>

    <!-- cash movement dialog -->
    <Dialog :open="moveOpen" @update:open="(o: boolean) => !o && (moveOpen = false)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move cash</DialogTitle>
          <DialogDescription>Every movement records who and why.</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="submitMovement">
          <div class="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel for="mv-type">Type</FieldLabel>
              <Select v-model="moveType">
                <SelectTrigger id="mv-type" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAID_IN">Paid in</SelectItem>
                  <SelectItem value="PAID_OUT">Paid out</SelectItem>
                  <SelectItem value="DROP">Safe drop</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="mv-amount">Amount</FieldLabel>
              <InputGroup class="h-8">
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput id="mv-amount" v-model="moveAmount" inputmode="decimal" autocomplete="off" class="tabular-nums" />
              </InputGroup>
            </Field>
          </div>
          <Field>
            <FieldLabel for="mv-reason">Reason</FieldLabel>
            <Input id="mv-reason" v-model="moveReason" autocomplete="off" maxlength="200" />
          </Field>
          <FieldError v-if="moveError">{{ moveError }}</FieldError>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="moveOpen = false">Cancel</Button>
            <Button type="submit" :disabled="moving || dollars(moveAmount) === null || !moveReason.trim()">
              {{ moving ? 'Recording…' : 'Record movement' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- close dialog: counted-first, no expected shown -->
    <Dialog :open="closeOpen" @update:open="(o: boolean) => !o && (closeOpen = false)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Close shift</DialogTitle>
          <DialogDescription>
            Count everything in the drawer and enter the total. Expected and variance are
            revealed after — the count comes first.
          </DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="submitClose">
          <InputGroup class="h-14">
            <InputGroupAddon class="text-lg">$</InputGroupAddon>
            <InputGroupInput
              v-model="countedStr"
              inputmode="decimal"
              autocomplete="off"
              autofocus
              class="text-center text-2xl font-bold tabular-nums"
              aria-label="Counted drawer total in dollars"
            />
          </InputGroup>
          <FieldError v-if="closeError">{{ closeError }}</FieldError>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="closeOpen = false">Cancel</Button>
            <Button type="submit" :disabled="closing || dollars(countedStr) === null">
              {{ closing ? 'Closing…' : 'Close shift' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
