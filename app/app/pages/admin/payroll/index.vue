<script setup lang="ts">
import { AlertTriangle, HandCoins } from '@lucide/vue'
import type { PayRunRow, PayrollPreview, PeriodSummary } from '@huta/shared/schemas'
import { formatMinutesAsHours } from '@huta/shared'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Spinner } from '~/components/ui/spinner'
import { FieldError } from '~/components/ui/field'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
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
import { money } from '~/lib/sale-format'
import { blockerView, payDay, periodLabel } from '~/lib/people-format'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * Payroll — review a fortnight and commit it (Kasan's pick 3: review here, PAY on the run).
 *
 * ⚠️ GROSS PAY ONLY. Every figure on this screen is what was earned before deductions. The
 * page says so out loud, because a number labelled only "pay" on a payroll screen will be
 * read as take-home.
 *
 * Committing ends this page's job. Paying people is `/admin/payroll/[id]` — often a different
 * day, sometimes three different methods, and giving it its own screen keeps the review from
 * carrying two jobs at once.
 */

useHead({ title: 'Payroll · Huta' })

const route = useRoute()
const router = useRouter()

const periods = ref<PeriodSummary[]>([])
const selected = ref<string | null>(
  typeof route.query['period'] === 'string' ? route.query['period'] : null,
)
const preview = ref<PayrollPreview | null>(null)
const loading = ref(true)
const previewing = ref(false)
const error = ref<string | null>(null)
const committing = ref(false)

function writeQuery() {
  void router.replace({ query: { period: selected.value ?? undefined } })
}

onMounted(async () => {
  try {
    const data = await apiFetch<{ periods: PeriodSummary[] }>('/payroll/periods')
    periods.value = data.periods
    // Default to the most recent CLOSED fortnight — the one you would actually be running.
    // The current period is still in progress and cannot be committed.
    if (!selected.value) {
      selected.value = data.periods.find((p) => !p.inProgress)?.periodStartDate
        ?? data.periods[0]?.periodStartDate
        ?? null
      writeQuery()
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not load pay periods.'
  } finally {
    loading.value = false
  }
})

let token = 0
watch(
  selected,
  async (periodStart) => {
    if (!periodStart) return
    const mine = ++token
    previewing.value = true
    error.value = null
    try {
      const data = await apiFetch<PayrollPreview>('/payroll/preview', {
        query: { periodStart },
      })
      if (mine !== token) return
      preview.value = data
    } catch (err) {
      if (mine !== token) return
      preview.value = null
      error.value = err instanceof ApiError ? err.message : 'Could not work out that fortnight.'
    } finally {
      if (mine === token) previewing.value = false
    }
  },
  { immediate: true },
)

const current = computed(() => periods.value.find((p) => p.periodStartDate === selected.value) ?? null)

const hm = (minutes: number) => formatMinutesAsHours(minutes)

/**
 * The blocker vocabulary moved to `lib/people-format.ts` on 2026-09-03, when the staff
 * command center became a second place that renders these sentences. One copy, so a wording
 * change lands on both screens.
 */
const blocker = (b: PayrollPreview['blockers'][number]) => blockerView(b)

/** ⚠️ Own ref — reka closes an AlertDialog before the fallthrough handler runs. */
const commitOpen = ref(false)

async function commit() {
  commitOpen.value = false
  if (!selected.value || committing.value) return
  committing.value = true
  error.value = null
  try {
    const run = await apiFetch<PayRunRow>('/payroll/runs', {
      method: 'POST',
      body: { periodStart: selected.value },
    })
    await router.push(`/admin/payroll/${run.id}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    committing.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start gap-3">
      <div>
        <h1 class="text-xl font-bold tracking-tight">Payroll</h1>
        <p class="text-sm text-muted-foreground">
          Gross pay from the timeclock.
          <template v-if="preview"> Weeks are cut in {{ preview.timezone.replace('_', ' ') }}.</template>
        </p>
      </div>
    </div>

    <!-- the fortnight -->
    <ToggleGroup
      v-if="periods.length"
      :model-value="selected ?? ''"
      type="single"
      :spacing="2"
      aria-label="Pay period"
      @update:model-value="(v) => { if (v) { selected = v as string; writeQuery() } }"
    >
      <ToggleGroupItem
        v-for="p in periods"
        :key="p.periodStartDate"
        :value="p.periodStartDate"
        class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
      >
        {{ periodLabel(p) }}
        <Badge v-if="p.inProgress" variant="secondary" class="h-5 px-1.5 text-[10px]">in progress</Badge>
        <Badge v-else-if="p.runId" class="h-5 bg-primary/15 px-1.5 text-[10px] text-primary">run</Badge>
      </ToggleGroupItem>
    </ToggleGroup>

    <FieldError v-if="error">{{ error }}</FieldError>

    <div v-if="loading || previewing" class="flex items-center gap-2 rounded-xl border bg-card px-4 py-10 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" /> Working out the fortnight…
    </div>

    <template v-else-if="preview">
      <!-- already committed: this page is done, the run owns it now -->
      <div
        v-if="preview.committedRunId"
        class="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3"
      >
        <div>
          <p class="text-sm font-semibold">This fortnight has been run.</p>
          <p class="text-sm text-muted-foreground">Paying people happens on the run itself.</p>
        </div>
        <Button size="sm" class="ml-auto" as-child>
          <NuxtLink :to="`/admin/payroll/${preview.committedRunId}`">Open the run</NuxtLink>
        </Button>
      </div>

      <!--
        Blockers. NOT an error state — this is the normal state on the day a fortnight closes,
        because somebody always forgets to clock out. Each one names the person and links to
        the fix.
      -->
      <div
        v-if="preview.blockers.length"
        class="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/[0.07]"
      >
        <div class="flex items-center gap-2 border-b border-amber-500/25 px-4 py-2.5 text-sm font-semibold text-amber-500">
          <AlertTriangle class="size-4" />
          {{ preview.blockers.length }}
          {{ preview.blockers.length === 1 ? 'thing to fix' : 'things to fix' }}
          before this fortnight can be paid
        </div>
        <div
          v-for="(b, i) in preview.blockers"
          :key="`${b.userId}-${b.timeEntryId ?? b.weekStartDate ?? i}`"
          class="flex flex-wrap items-center gap-3 border-b border-amber-500/15 px-4 py-2.5 text-sm last:border-b-0"
        >
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
            :class="blocker(b).tone"
          >{{ blocker(b).label }}</span>
          <span><b>{{ b.userName }}</b> {{ blocker(b).sentence }}</span>
          <Button variant="outline" size="sm" class="ml-auto h-7" as-child>
            <NuxtLink :to="blocker(b).href">{{ blocker(b).action }}</NuxtLink>
          </Button>
        </div>
      </div>

      <p v-for="note in preview.notes" :key="note" class="text-xs text-muted-foreground">
        {{ note }}
      </p>

      <!-- the figures -->
      <div v-if="preview.lines.length" class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums text-primary">{{ money(preview.grossCents) }}</div>
          <div class="text-xs text-muted-foreground">Gross</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">before any deductions</div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums">{{ hm(preview.totalMinutes) }}</div>
          <div class="text-xs text-muted-foreground">Hours</div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <!-- Overtime is its own figure, never folded into the hours total — the same rule
               the Hours tab follows for estimated time. -->
          <div class="text-lg font-bold tabular-nums" :class="preview.overtimeMinutes > 0 ? 'text-amber-500' : ''">
            {{ preview.overtimeMinutes > 0 ? hm(preview.overtimeMinutes) : '—' }}
          </div>
          <div class="text-xs text-muted-foreground">Overtime</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">over 40h in a week</div>
        </div>
        <div class="rounded-xl border bg-card px-3.5 py-2.5">
          <div class="text-lg font-bold tabular-nums">{{ preview.lines.length }}</div>
          <div class="text-xs text-muted-foreground">
            {{ preview.lines.length === 1 ? 'Person' : 'People' }}
          </div>
        </div>
      </div>

      <div v-if="preview.lines.length" class="rounded-xl border bg-card" :class="preview.blockers.length ? 'opacity-60' : ''">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead
                v-for="w in preview.lines[0]?.weeks ?? []"
                :key="w.weekStartDate"
                class="text-right"
              >
                Week of {{ payDay(w.weekStartDate) }}
              </TableHead>
              <TableHead class="text-right">Hours</TableHead>
              <TableHead class="text-right">Overtime</TableHead>
              <TableHead class="text-right">Gross</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="line in preview.lines" :key="line.userId">
              <TableCell class="font-medium">{{ line.userName }}</TableCell>
              <TableCell
                v-for="w in line.weeks"
                :key="w.weekStartDate"
                class="text-right tabular-nums text-muted-foreground"
              >
                {{ hm(w.minutesWorked) }}
                <span v-if="w.overtimeMinutes > 0" class="text-amber-500">·&nbsp;{{ hm(w.overtimeMinutes) }} OT</span>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ hm(line.totalMinutes) }}</TableCell>
              <TableCell class="text-right tabular-nums" :class="line.overtimeMinutes > 0 ? 'text-amber-500' : 'text-muted-foreground'">
                {{ line.overtimeMinutes > 0 ? hm(line.overtimeMinutes) : '—' }}
              </TableCell>
              <TableCell class="text-right font-semibold tabular-nums">{{ money(line.grossCents) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <Empty v-else class="flex-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><HandCoins /></EmptyMedia>
          <EmptyTitle>Nobody worked in this fortnight</EmptyTitle>
          <EmptyDescription>There is nothing to pay.</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <!-- commit -->
      <div
        v-if="preview.lines.length && !preview.committedRunId"
        class="flex flex-wrap items-center gap-3 border-t pt-3"
      >
        <p class="mr-auto max-w-prose text-xs text-muted-foreground">
          <span class="font-medium text-foreground">Gross only.</span>
          Hand this figure to whoever does your withholding — nothing here deducts tax.
          <template v-if="current?.inProgress">
            This fortnight is still running, so it cannot be committed yet.
          </template>
        </p>
        <Button
          :disabled="!preview.payable || committing || current?.inProgress"
          @click="commitOpen = true"
        >
          {{ committing ? 'Committing…' : 'Commit this run' }}
        </Button>
      </div>
    </template>

    <AlertDialog :open="commitOpen" @update:open="(o: boolean) => !o && (commitOpen = false)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Commit {{ preview ? periodLabel(preview) : '' }}?</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="preview">
              {{ money(preview.grossCents) }} gross across {{ preview.lines.length }}
              {{ preview.lines.length === 1 ? 'person' : 'people' }}. The figures are frozen at
              what they are now — correcting a timesheet afterwards means reversing the run and
              running it again.
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Not yet</AlertDialogCancel>
          <AlertDialogAction :disabled="committing" @click="commit">Commit run</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
