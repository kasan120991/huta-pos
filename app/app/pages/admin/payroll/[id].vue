<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import type { PayRunDetail, PayRunLineRow } from '@huta/shared/schemas'
import { formatMinutesAsHours } from '@huta/shared'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Spinner } from '~/components/ui/spinner'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { money } from '~/lib/sale-format'
import { dollars, parseDollars } from '~/lib/money'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * A committed pay run — who is owed what, and paying them (Kasan's pick 3).
 *
 * The review page ends at Commit; this is the second act. Often a different day, sometimes
 * three different methods, and a line can be paid in parts — none of which fits comfortably
 * beside a preview whose job is to be checked and frozen.
 *
 * ⚠️ GROSS. Every figure is before deductions.
 */

const route = useRoute()
const router = useRouter()

const run = ref<PayRunDetail | null>(null)
/**
 * Stores that can actually pay cash right now.
 *
 * `CashMovement.shiftId` is NOT NULL, so a cash payout needs an OPEN drawer at that store.
 * Offering a store with no drawer open is offering a choice that can only fail — so the
 * picker says which tills are live and how much is in them, and defaults to one that works.
 */
const stores = ref<Array<{ id: string, name: string, shiftId: string | null, balanceCents: number | null }>>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)

useHead({ title: 'Pay run · Huta' })

async function load() {
  try {
    run.value = await apiFetch<PayRunDetail>(`/payroll/runs/${route.params['id'] as string}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not open that run.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const drawers = await apiFetch<{
    drawers: Array<{ storeId: string, storeName: string, shiftId: string | null, balanceCents: number | null }>
  }>('/shifts/live').catch(() => null)
  stores.value = (drawers?.drawers ?? []).map((d) => ({
    id: d.storeId,
    name: d.storeName,
    shiftId: d.shiftId,
    balanceCents: d.balanceCents,
  }))
  await load()
})

const tillsOpen = computed(() => stores.value.filter((s) => s.shiftId !== null))

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const day = (d: string) => dateFmt.format(new Date(`${d}T12:00:00`))
const hm = (m: number) => formatMinutesAsHours(m)

const totals = computed(() => {
  const lines = run.value?.lines ?? []
  const paid = lines.reduce((a, l) => a + l.paidCents, 0)
  return {
    paid,
    outstanding: lines.reduce((a, l) => a + l.outstandingCents, 0),
    paidPeople: lines.filter((l) => l.outstandingCents === 0).length,
  }
})

/* ————— paying somebody ————— */
const payOpen = ref(false)
const payLine = ref<PayRunLineRow | null>(null)
const payMethod = ref<'CASH' | 'CHECK' | 'BANK'>('BANK')
const payAmount = ref('')
const payReference = ref('')
const payStoreId = ref('')
const payError = ref<string | null>(null)

function startPay(line: PayRunLineRow) {
  payLine.value = line
  payMethod.value = 'BANK'
  // Default to what is left, which is what you are almost always paying.
  payAmount.value = dollars(line.outstandingCents)
  payReference.value = ''
  // Default to a till that is actually open; there is usually exactly one.
  payStoreId.value = tillsOpen.value[0]?.id ?? ''
  payError.value = null
  payOpen.value = true
}

const payCents = computed(() => parseDollars(payAmount.value))
const payValid = computed(
  () =>
    payLine.value !== null &&
    payCents.value !== null &&
    payCents.value > 0 &&
    payCents.value <= payLine.value.outstandingCents &&
    (payMethod.value !== 'CASH' || payStoreId.value !== ''),
)

async function submitPay() {
  if (!payValid.value || !payLine.value || busy.value) return
  busy.value = true
  payError.value = null
  try {
    await apiFetch(`/payroll/lines/${payLine.value.id}/payouts`, {
      method: 'POST',
      body: {
        method: payMethod.value,
        amountCents: payCents.value,
        ...(payReference.value.trim() ? { reference: payReference.value.trim() } : {}),
        ...(payMethod.value === 'CASH' ? { storeId: payStoreId.value } : {}),
      },
    })
    payOpen.value = false
    await load()
  } catch (err) {
    payError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    busy.value = false
  }
}

/* ————— reversing ————— */
/** ⚠️ Own ref — reka closes on click before the fallthrough handler runs. */
const reverseOpen = ref(false)
const reverseNote = ref('')

async function reverse() {
  if (!run.value || !reverseNote.value.trim() || busy.value) return
  busy.value = true
  error.value = null
  try {
    await apiFetch(`/payroll/runs/${run.value.id}/reverse`, {
      method: 'POST',
      body: { note: reverseNote.value.trim() },
    })
    reverseOpen.value = false
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    busy.value = false
  }
}

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', CHECK: 'Check', BANK: 'Bank' }
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start gap-3">
      <Button variant="ghost" size="sm" as-child class="-ml-2 h-8">
        <NuxtLink to="/admin/payroll"><ArrowLeft class="size-4" /> Payroll</NuxtLink>
      </Button>
      <div v-if="run" class="min-w-0">
        <h1 class="text-xl font-bold tracking-tight">
          {{ day(run.periodStartDate) }} – {{ day(run.periodEndDate) }}
        </h1>
        <p class="text-sm text-muted-foreground">
          Committed by {{ run.committedByName }} ·
          {{ new Date(run.committedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }}
          <template v-if="run.note"> · {{ run.note }}</template>
        </p>
      </div>
      <Badge
        v-if="run"
        class="ml-auto"
        :class="run.status === 'REVERSED' ? 'bg-red-400/15 text-red-400' : 'bg-primary/15 text-primary'"
      >
        {{ run.status === 'REVERSED' ? 'Reversed' : 'Committed' }}
      </Badge>
    </div>

    <div v-if="loading" class="flex items-center gap-2 rounded-xl border bg-card px-4 py-10 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" /> Loading the run…
    </div>
    <FieldError v-else-if="error">{{ error }}</FieldError>

    <template v-else-if="run">
      <p
        v-if="run.status === 'REVERSED'"
        class="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-400"
      >
        This run was reversed{{ run.reversedByName ? ` by ${run.reversedByName}` : '' }} —
        {{ run.reversalNote }}. Its figures are kept as a record; the fortnight can be run again.
      </p>

      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums">{{ money(run.grossCents) }}</div>
          <div class="text-xs text-muted-foreground">Gross</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">before any deductions</div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums text-primary">{{ money(totals.paid) }}</div>
          <div class="text-xs text-muted-foreground">Paid</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">
            {{ totals.paidPeople }} of {{ run.lines.length }}
            {{ run.lines.length === 1 ? 'person' : 'people' }}
          </div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div
            class="text-lg font-bold tabular-nums"
            :class="totals.outstanding > 0 ? 'text-amber-500' : 'text-muted-foreground'"
          >
            {{ totals.outstanding > 0 ? money(totals.outstanding) : '—' }}
          </div>
          <div class="text-xs text-muted-foreground">Still to pay</div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums" :class="run.overtimeMinutes > 0 ? 'text-amber-500' : ''">
            {{ run.overtimeMinutes > 0 ? hm(run.overtimeMinutes) : '—' }}
          </div>
          <div class="text-xs text-muted-foreground">Overtime</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">of {{ hm(run.totalMinutes) }}</div>
        </div>
      </div>

      <div class="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead class="text-right">Hours</TableHead>
              <TableHead class="text-right">Gross</TableHead>
              <TableHead class="text-right">Paid</TableHead>
              <TableHead class="text-right">Outstanding</TableHead>
              <TableHead class="text-right"><span class="sr-only">Pay</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="line in run.lines" :key="line.id">
              <TableCell>
                <span class="font-medium">{{ line.userName }}</span>
                <span v-if="line.overtimeMinutes > 0" class="block text-xs text-amber-500">
                  {{ hm(line.overtimeMinutes) }} overtime
                </span>
                <!-- Every payout that stands, so a part-paid line explains itself in place. -->
                <span
                  v-for="p in line.payouts.filter((x) => x.reversedAt === null)"
                  :key="p.id"
                  class="block text-xs text-muted-foreground"
                >
                  {{ METHOD_LABEL[p.method] ?? p.method }} {{ money(p.amountCents) }}
                  <template v-if="p.reference"> · {{ p.reference }}</template>
                </span>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ hm(line.totalMinutes) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ money(line.grossCents) }}</TableCell>
              <TableCell class="text-right tabular-nums" :class="line.paidCents > 0 ? 'text-primary' : 'text-muted-foreground'">
                {{ line.paidCents > 0 ? money(line.paidCents) : '—' }}
              </TableCell>
              <TableCell class="text-right font-semibold tabular-nums" :class="line.outstandingCents > 0 ? 'text-amber-500' : 'text-muted-foreground'">
                {{ line.outstandingCents > 0 ? money(line.outstandingCents) : '—' }}
              </TableCell>
              <TableCell class="text-right">
                <Button
                  v-if="line.outstandingCents > 0 && run.status !== 'REVERSED'"
                  size="sm"
                  class="h-7"
                  @click="startPay(line)"
                >
                  Pay…
                </Button>
                <span v-else-if="line.outstandingCents === 0" class="text-xs text-muted-foreground">Paid</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div class="flex flex-wrap items-center gap-3 border-t pt-3">
        <p class="mr-auto max-w-prose text-xs text-muted-foreground">
          Cash payouts come out of an open drawer, so the count at close accounts for them.
          <span class="font-medium text-foreground">The till is just where the notes come from</span> —
          it has nothing to do with which store the hours were worked at.
        </p>
        <Button
          v-if="run.status !== 'REVERSED'"
          variant="outline"
          size="sm"
          class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
          :disabled="busy"
          @click="reverseOpen = true"
        >
          Reverse this run…
        </Button>
      </div>
    </template>

    <!-- pay somebody -->
    <Dialog :open="payOpen" @update:open="(o: boolean) => !o && (payOpen = false)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pay {{ payLine?.userName }}</DialogTitle>
          <DialogDescription>
            {{ payLine ? money(payLine.outstandingCents) : '' }} outstanding of
            {{ payLine ? money(payLine.grossCents) : '' }} gross.
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-3">
          <Field>
            <FieldLabel for="pay-method" class="text-xs">How</FieldLabel>
            <Select v-model="payMethod">
              <SelectTrigger id="pay-method" class="w-full data-[size=default]:h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="BANK">Bank transfer</SelectItem>
                <SelectItem value="CHECK">Check</SelectItem>
                <SelectItem value="CASH">Cash from a till</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel for="pay-amount" class="text-xs">Amount</FieldLabel>
            <InputGroup class="h-9">
              <InputGroupAddon class="text-xs">$</InputGroupAddon>
              <InputGroupInput id="pay-amount" v-model="payAmount" inputmode="decimal" autocomplete="off" class="tabular-nums" />
            </InputGroup>
            <p v-if="payLine && payCents !== null && payCents > payLine.outstandingCents" class="text-xs text-red-400">
              That is more than the {{ money(payLine.outstandingCents) }} outstanding.
            </p>
          </Field>

          <!-- Only CASH touches a drawer, so the store picker only exists for CASH. -->
          <Field v-if="payMethod === 'CASH'">
            <FieldLabel for="pay-store" class="text-xs">Out of which till</FieldLabel>
            <Select v-model="payStoreId">
              <SelectTrigger id="pay-store" class="w-full data-[size=default]:h-9">
                <SelectValue placeholder="Pick a store" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="s in stores"
                  :key="s.id"
                  :value="s.id"
                  :disabled="s.shiftId === null"
                >
                  {{ s.name }}
                  <span v-if="s.shiftId === null" class="text-muted-foreground"> — no drawer open</span>
                  <span v-else-if="s.balanceCents !== null" class="text-muted-foreground">
                    — {{ money(s.balanceCents) }} in the till
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!tillsOpen.length" class="text-xs text-amber-500">
              No drawer is open anywhere, so cash cannot be paid out right now. Open one at a
              register, or pay by check or transfer.
            </p>
            <p v-else class="text-xs text-muted-foreground">
              The money leaves that drawer, so its close accounts for it. Which till it comes
              out of has nothing to do with where the hours were worked.
            </p>
          </Field>

          <Field v-else>
            <FieldLabel for="pay-ref" class="text-xs">
              Reference <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="pay-ref" v-model="payReference" autocomplete="off" maxlength="120" class="h-9" placeholder="Check number, transfer id…" />
          </Field>

          <FieldError v-if="payError">{{ payError }}</FieldError>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="payOpen = false">Cancel</Button>
          <Button :disabled="!payValid || busy" @click="submitPay">
            {{ busy ? 'Recording…' : 'Record payment' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- reverse: needs a reason, and refuses while money has gone out -->
    <AlertDialog :open="reverseOpen" @update:open="(o: boolean) => !o && (reverseOpen = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse this run?</AlertDialogTitle>
          <AlertDialogDescription>
            The figures are kept exactly as committed — reversing supersedes them rather than
            erasing them — and the fortnight becomes available to run again. Any payout already
            made has to be reversed first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="px-6">
          <Field>
            <FieldLabel for="reverse-note" class="text-xs">Why</FieldLabel>
            <Input id="reverse-note" v-model="reverseNote" autocomplete="off" maxlength="300" class="h-9" placeholder="Wrong rate on file…" />
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            :disabled="!reverseNote.trim() || busy"
            @click="reverse"
          >
            Reverse run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
