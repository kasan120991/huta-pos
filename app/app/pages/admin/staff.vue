<script setup lang="ts">
import type {
  CatalogReference,
  ShiftListRow,
  StaffAdminRow,
  TimeEntryPage,
  TimeEntryRow,
} from '@huta/shared/schemas'

/** Shapes returned by GET /auth/users/:id/activity — server-side only, so declared here. */
interface ActivityTotals {
  saleCount: number
  grossCents: number
  averageSaleCents: number | null
  drawersOpened: number
  drawersClosed: number
  refundsIssued: number
  refundsApproved: number
  stockMovements: number
  cashMovements: number
}
interface AuditFeedRow {
  id: string
  action: string
  entityType: string
  entityId: string
  at: string
}
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
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Input } from '~/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Spinner } from '~/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Toggle } from '~/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { PersonPaySummary, WageRateRow } from '@huta/shared/schemas'
import { formatMinutesAsHours } from '@huta/shared'
import { dollars, parseDollars } from '~/lib/money'
import { ApiError, apiFetch } from '~/composables/useApi'
import { money, varianceView } from '~/lib/sale-format'
import { Clock, Lock, UserX } from '@lucide/vue'

/**
 * Staff (Kasan's option A, 2026-08-22) — index, then a full workspace.
 *
 * The `suppliers.vue` shape: two views in one route, selection in the URL so a person is
 * linkable, and a dirty-diff PATCH so an untouched form makes no request. Chosen over a
 * slide-over because phases 3 and 4 add Hours, Drawers and an Activity feed to the
 * per-person view, and a 290px panel would have to be thrown away to fit them.
 *
 * TWO STATES ARE WORK, NOT INFORMATION — locked out, and a PIN reset still outstanding.
 * They surface on the index above the table, because the point of this screen is that they
 * get fixed without being hunted for. Same lesson as the transfers queue.
 */
definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()

const people = ref<StaffAdminRow[]>([])
const stores = ref<CatalogReference['stores']>([])
const loading = ref(true)
const pageError = ref<string | null>(null)
const showInactive = ref(false)

const selectedId = ref<string | null>(
  typeof route.query['person'] === 'string' ? route.query['person'] : null,
)
function open(id: string | null) {
  selectedId.value = id
  void router.replace({ query: { ...route.query, person: id ?? undefined } })
}
const selected = computed(() => people.value.find((p) => p.id === selectedId.value) ?? null)

const visible = computed(() =>
  showInactive.value ? people.value : people.value.filter((p) => p.active),
)

/** Locked out, or holding a temporary PIN they have not replaced yet. */
const needsAttention = computed(() =>
  people.value.filter((p) => p.active && (isLocked(p) || p.mustChangePin)),
)

function isLocked(p: StaffAdminRow): boolean {
  return p.lockedUntil !== null && new Date(p.lockedUntil) > new Date()
}

async function load() {
  loading.value = true
  pageError.value = null
  try {
    const [list, reference] = await Promise.all([
      apiFetch<{ users: StaffAdminRow[] }>('/auth/users', { query: { includeInactive: 'true' } }),
      apiFetch<CatalogReference>('/catalog/reference'),
    ])
    people.value = list.users
    stores.value = reference.stores
  }
  catch (err) {
    pageError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
  finally {
    loading.value = false
  }
}
onMounted(load)

/* ————— formatting ————— */
const fullName = (p: StaffAdminRow) => `${p.firstName} ${p.lastName}`
const initials = (p: StaffAdminRow) =>
  `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase()

function when(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? `Today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function lockedUntilText(p: StaffAdminRow): string {
  if (!p.lockedUntil) return ''
  return new Date(p.lockedUntil).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/* ————— the add / edit dialog ————— */
interface Draft {
  firstName: string
  lastName: string
  email: string
  storeId: string
}
const BLANK: Draft = { firstName: '', lastName: '', email: '', storeId: '' }

const editorOpen = ref(false)
const editing = ref<StaffAdminRow | null>(null)
const draft = ref<Draft>({ ...BLANK })
const original = ref<Draft>({ ...BLANK })
const saving = ref(false)
const editError = ref<string | null>(null)
const emailError = ref<string | null>(null)

/** House rule: state resets when the dialog OPENS, never when it closes. */
function startEdit(person: StaffAdminRow | null) {
  editing.value = person
  const from: Draft = person
    ? {
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email ?? '',
        storeId: person.store?.id ?? '',
      }
    : { ...BLANK }
  draft.value = { ...from }
  original.value = { ...from }
  editError.value = null
  emailError.value = null
  editorOpen.value = true
}

function buildPatch(): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const before = original.value
  const now = draft.value
  if (now.firstName.trim() !== before.firstName.trim()) patch['firstName'] = now.firstName.trim()
  if (now.lastName.trim() !== before.lastName.trim()) patch['lastName'] = now.lastName.trim()
  if (now.email.trim() !== before.email.trim()) {
    patch['email'] = now.email.trim() === '' ? null : now.email.trim()
  }
  if (now.storeId !== before.storeId) patch['storeId'] = now.storeId
  return patch
}

const canSave = computed(
  () =>
    draft.value.firstName.trim() !== ''
    && draft.value.lastName.trim() !== ''
    && (editing.value !== null || draft.value.storeId !== ''),
)

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  editError.value = null
  emailError.value = null
  try {
    if (editing.value) {
      const patch = buildPatch()
      // An untouched form makes no request and writes no audit row.
      if (Object.keys(patch).length > 0) {
        await apiFetch(`/auth/users/${editing.value.id}`, { method: 'PATCH', body: patch })
      }
      editorOpen.value = false
      await load()
    }
    else {
      const created = await apiFetch<{ user: StaffAdminRow, pin: string }>('/auth/users', {
        method: 'POST',
        body: {
          firstName: draft.value.firstName.trim(),
          lastName: draft.value.lastName.trim(),
          ...(draft.value.email.trim() ? { email: draft.value.email.trim() } : {}),
          storeId: draft.value.storeId,
        },
      })
      editorOpen.value = false
      await load()
      // Chain straight into the reveal, the way registers.vue chains into its pairing code.
      revealFor.value = { name: fullName(created.user), pin: created.pin }
    }
  }
  catch (err) {
    const message = err instanceof ApiError ? err.message : 'Something went wrong.'
    // A collision must not cost the admin the rest of the form — land it on the field.
    if (/email/i.test(message)) emailError.value = message
    else editError.value = message
  }
  finally {
    saving.value = false
  }
}

/* ————— the one-time PIN reveal ————— */
const revealFor = ref<{ name: string, pin: string } | null>(null)
const copied = ref(false)

async function copyPin() {
  if (!revealFor.value) return
  try {
    await navigator.clipboard.writeText(revealFor.value.pin)
    copied.value = true
    setTimeout(() => (copied.value = false), 1800)
  }
  catch {
    // Clipboard can be refused; the PIN is on screen either way.
  }
}

/* ————— per-person actions ————— */
const actionError = ref<string | null>(null)
const busy = ref(false)
/**
 * ⚠️ Open state is a SEPARATE ref from the person. reka's `AlertDialogAction` closes the
 * dialog on click, and that close fires `@update:open` before the handler runs — so reading
 * `deactivating.value` inside `confirmDeactivate` found null and did nothing at all. See
 * registers.vue for the full account.
 */
const deactivating = ref<StaffAdminRow | null>(null)
const deactivateOpen = ref(false)

async function act(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    await fn()
    await load()
  }
  catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
  finally {
    busy.value = false
  }
}

function resetPin(person: StaffAdminRow) {
  void act(async () => {
    const res = await apiFetch<{ userId: string, pin: string }>(
      `/auth/users/${person.id}/pin/reset`,
      { method: 'POST' },
    )
    revealFor.value = { name: fullName(person), pin: res.pin }
  })
}

const clearLockout = (person: StaffAdminRow) =>
  act(() => apiFetch(`/auth/users/${person.id}/unlock`, { method: 'POST' }))

const setActive = (person: StaffAdminRow, active: boolean) =>
  act(() => apiFetch(`/auth/users/${person.id}`, { method: 'PATCH', body: { active } }))

function confirmDeactivate() {
  const person = deactivating.value
  deactivateOpen.value = false
  if (person) void setActive(person, false)
}

/* ————— counters and history (Kasan's B, 2026-08-22) ————— */
const totals = ref<ActivityTotals | null>(null)
const feed = ref<AuditFeedRow[]>([])
const drawers = ref<ShiftListRow[]>([])
const historyLoading = ref(false)
const historyFilter = ref<'all' | 'drawers' | 'admin'>('all')

/**
 * Counters live on OVERVIEW, not behind a tab — they are the part anyone actually looks at,
 * and Overview was two small boxes on a full-width page. Loaded with the person, because
 * they are part of the answer to "how is this person doing".
 *
 * ⚠️ Never call this from the INDEX. Ten people times six aggregates is sixty queries for a
 * page that shows a table; the service comment says so too.
 */
async function loadPerson(userId: string) {
  historyLoading.value = true
  try {
    const [activity, shifts] = await Promise.all([
      apiFetch<{ totals: ActivityTotals, feed: AuditFeedRow[] }>(`/auth/users/${userId}/activity`),
      apiFetch<{ shifts: ShiftListRow[] }>('/shifts', { query: { userId } }),
    ])
    if (selectedId.value !== userId) return // stale-response guard
    totals.value = activity.totals
    feed.value = activity.feed
    drawers.value = shifts.shifts
  }
  catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
  finally {
    historyLoading.value = false
  }
}

interface TimelineItem {
  id: string
  at: string
  kind: 'drawer' | 'admin'
  title: string
  detail: string
  short: boolean
}

/**
 * Drawers and admin writes in ONE reverse-chronological list.
 *
 * They belong together: both answer "what did this person do", and a typical cashier has
 * four of each — two half-empty tables, or one page worth reading. A drawer they both opened
 * AND closed is one row at the open, not two, because it is one stretch of custody.
 */
const timeline = computed<TimelineItem[]>(() => {
  const id = selectedId.value
  const items: TimelineItem[] = []

  if (historyFilter.value !== 'admin') {
    for (const d of drawers.value) {
      const opened = d.openedByName === fullNameOf(id)
      const closed = d.closedByName !== null && d.closedByName === fullNameOf(id)
      // One vocabulary with the register and the drawer list — see `varianceView`.
      const v = varianceView(d.varianceCents, d.status)
      const variance = v.off ? `${v.amount} ${v.word}` : v.word === 'exact' ? v.amount : v.word
      items.push({
        id: `shift-${d.id}`,
        // Dated by the end of their involvement, so a drawer they closed sorts where they
        // closed it rather than where someone else opened it.
        at: closed && !opened && d.closedAt ? d.closedAt : d.openedAt,
        kind: 'drawer',
        title: opened && closed
          ? `Opened and closed the ${d.storeName} drawer`
          : opened
            ? `Opened the ${d.storeName} drawer`
            : `Closed the ${d.storeName} drawer`,
        detail: `${d.saleCount} ${d.saleCount === 1 ? 'sale' : 'sales'} · ${variance}`,
        short: v.off,
      })
    }
  }

  if (historyFilter.value !== 'drawers') {
    for (const row of feed.value) {
      items.push({
        id: `audit-${row.id}`,
        at: row.at,
        kind: 'admin',
        title: auditLabel(row.action),
        detail: row.entityType,
        short: false,
      })
    }
  }

  return items.sort((a, b) => b.at.localeCompare(a.at))
})

/** Grouped into days for the same reason the Hours tab is: a day is how people recall work. */
const timelineDays = computed(() => {
  const groups = new Map<string, { label: string, items: TimelineItem[] }>()
  for (const item of timeline.value) {
    const d = new Date(item.at)
    const key = isoDay(d)
    const g = groups.get(key) ?? {
      label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      items: [],
    }
    g.items.push(item)
    groups.set(key, g)
  }
  return [...groups.values()]
})

const fullNameOf = (id: string | null) => {
  const p = people.value.find((x) => x.id === id)
  return p ? `${p.firstName} ${p.lastName}` : ''
}


/**
 * `catalog.variant.update` reads as machinery. This turns the dotted action into something
 * a person recognises, and falls back to the raw string rather than hiding an action it does
 * not know — a new one appearing unlabelled is better than it vanishing.
 */
const AUDIT_LABELS: Record<string, string> = {
  'auth.terminal.create': 'Added a register',
  'auth.terminal.update': 'Changed a register',
  'auth.user.create': 'Added a staff member',
  'auth.user.update': 'Edited a staff member',
  'auth.user.resetPin': 'Reset a PIN',
  'auth.user.clearLockout': 'Cleared a lockout',
  'catalog.brand.create': 'Added a brand',
  'catalog.product.create': 'Added a product',
  'catalog.product.update': 'Edited a product',
  'catalog.product.cannabinoids': 'Changed a product\u2019s potency',
  'catalog.product.images': 'Changed product images',
  'catalog.variant.create': 'Added a variant',
  'catalog.variant.update': 'Edited a variant',
  'catalog.variant.cannabinoids': 'Changed a strain\u2019s potency',
  'inventory.adjust': 'Adjusted stock',
  'inventory.cost': 'Costed a delivery',
  'inventory.receive': 'Recorded a delivery',
  'inventory.reconcileWeight': 'Reconciled flower weight',
  'timeclock.correct': 'Corrected a time entry',
  'timeclock.void': 'Voided a time entry',
}

const auditLabel = (action: string) => AUDIT_LABELS[action] ?? action

/* ————— the Hours tab ————— */
const hours = ref<TimeEntryPage | null>(null)
const hoursLoading = ref(false)
/* ————— wage and pay (Kasan's picks A + B, 2026-08-24) ————— */

/**
 * ⚠️ GROSS pay throughout. Nothing in this system withholds tax, so no figure here is
 * take-home and none of them may be labelled as such.
 */
const wageRates = ref<WageRateRow[]>([])
const pay = ref<PersonPaySummary | null>(null)
const wageLoading = ref(false)

const currentWage = computed(() => wageRates.value.find((r) => r.current) ?? null)
const earlierWages = computed(() => wageRates.value.filter((r) => !r.current))

async function loadWage(id: string) {
  wageLoading.value = true
  try {
    const data = await apiFetch<{ rates: WageRateRow[] }>(`/payroll/wages/${id}`)
    if (selectedId.value !== id) return
    wageRates.value = data.rates
  } catch {
    wageRates.value = []
  } finally {
    if (selectedId.value === id) wageLoading.value = false
  }
}

async function loadPay(id: string) {
  try {
    const data = await apiFetch<PersonPaySummary>(`/payroll/people/${id}`)
    if (selectedId.value !== id) return
    pay.value = data
  } catch {
    pay.value = null
  }
}

/* the wage dialog */
const wageOpen = ref(false)
const wageAmount = ref('')
const wageFrom = ref('')
const wageNote = ref('')
const wageError = ref<string | null>(null)
const wageSaving = ref(false)

function startWage() {
  wageAmount.value = currentWage.value ? dollars(currentWage.value.ratePerHourCents) : ''
  wageFrom.value = new Date().toISOString().slice(0, 10)
  wageNote.value = ''
  wageError.value = null
  wageOpen.value = true
}

const wageCents = computed(() => parseDollars(wageAmount.value))
const wageValid = computed(() => wageCents.value !== null && wageCents.value > 0 && wageFrom.value !== '')

/** The Sunday the chosen date falls in — what the server will actually store. */
const wageSunday = computed(() => {
  if (!wageFrom.value) return null
  const [y, m, d] = wageFrom.value.split('-').map(Number) as [number, number, number]
  const at = new Date(Date.UTC(y, m - 1, d))
  at.setUTCDate(at.getUTCDate() - at.getUTCDay())
  return at.toISOString().slice(0, 10)
})

async function saveWage() {
  if (!wageValid.value || !selectedId.value || wageSaving.value) return
  wageSaving.value = true
  wageError.value = null
  try {
    await apiFetch(`/payroll/wages/${selectedId.value}`, {
      method: 'POST',
      body: {
        ratePerHourCents: wageCents.value,
        effectiveFrom: wageFrom.value,
        ...(wageNote.value.trim() ? { note: wageNote.value.trim() } : {}),
      },
    })
    wageOpen.value = false
    await loadWage(selectedId.value)
    await loadPay(selectedId.value)
  } catch (err) {
    wageError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    wageSaving.value = false
  }
}

const perHour = (cents: number) => `${money(cents)}/hr`
const payDay = (d: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00`))

const RANGES = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
] as const
const range = ref<(typeof RANGES)[number]['key']>('30')

/** `YYYY-MM-DD`, which is what the endpoint takes — business days, not instants. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function loadHours(userId: string) {
  hoursLoading.value = true
  try {
    const from = new Date()
    from.setDate(from.getDate() - Number(range.value))
    const res = await apiFetch<TimeEntryPage>('/timeclock/entries', {
      query: { userId, from: isoDay(from), to: isoDay(new Date()) },
    })
    // Stale-response guard: the admin may have moved on while this was in flight.
    if (selectedId.value !== userId) return
    hours.value = res
  }
  catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
  finally {
    hoursLoading.value = false
  }
}

/** Entries grouped into the days they STARTED on. An overnight shift belongs to its start. */
const hourDays = computed(() => {
  const groups = new Map<string, { label: string, entries: TimeEntryRow[], minutes: number, estimated: number }>()
  for (const e of hours.value?.entries ?? []) {
    const d = new Date(e.clockedInAt)
    const key = isoDay(d)
    const group = groups.get(key) ?? {
      label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      entries: [],
      minutes: 0,
      estimated: 0,
    }
    group.entries.push(e)
    if (e.minutes !== null) {
      if (e.status === 'AUTO') group.estimated += e.minutes
      else group.minutes += e.minutes
    }
    groups.set(key, group)
  }
  return [...groups.values()]
})

/**
 * Durations render through the SHARED formatter, not a local copy.
 *
 * The local one printed "82h 0m" where the payroll page printed "82h" — the same duration,
 * two spellings, on two screens showing the same person's fortnight. Caught the day the Pay
 * tab landed beside it.
 */
const hm = (total: number): string => formatMinutesAsHours(total)

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/* ————— correcting an entry ————— */
const fixing = ref<TimeEntryRow | null>(null)
const fixStart = ref('')
const fixEnd = ref('')
/**
 * Whether the START is being edited (Kasan's pick B).
 *
 * The end time is what is nearly always wrong — people remember to clock in and forget to
 * clock out — so the start opens as a fact with a Change link beside it. Still visible, so it
 * can be checked without being touched.
 */
const fixStartOpen = ref(false)
const fixNote = ref('')
const fixError = ref<string | null>(null)

const pad2 = (n: number) => String(n).padStart(2, '0')
/** A Date → the `datetime-local` shape, in the browser's zone, which is what the input reads. */
function toLocalInput(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

function startFix(entry: TimeEntryRow) {
  fixing.value = entry
  fixStart.value = toLocalInput(new Date(entry.clockedInAt))
  // Seed with whatever the system guessed, so the admin edits rather than retypes.
  fixEnd.value = toLocalInput(entry.clockedOutAt ? new Date(entry.clockedOutAt) : new Date())
  fixStartOpen.value = false
  fixNote.value = ''
  fixError.value = null
}

/** Null while an entry is still running — there is nothing to measure yet. */
const fixMinutes = computed(() => {
  if (!fixing.value) return null
  const start = fixStart.value ? new Date(fixStart.value) : null
  const end = fixEnd.value ? new Date(fixEnd.value) : null
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)
  return minutes > 0 ? minutes : null
})

/** What the entry says NOW, so the strip can show what is being replaced. */
const fixWasMinutes = computed(() => fixing.value?.minutes ?? null)

const fixStartMoved = computed(
  () =>
    fixing.value !== null &&
    fixStart.value !== '' &&
    new Date(fixStart.value).getTime() !== new Date(fixing.value.clockedInAt).getTime(),
)

/** A fortnight that has been paid is closed to edits — say so before anybody types. */
const fixLocked = computed(() => fixing.value?.paidRunId ?? null)

const fixValid = computed(
  () => fixLocked.value === null && fixNote.value.trim() !== '' && fixEnd.value !== '' && fixMinutes.value !== null,
)

async function saveFix() {
  const entry = fixing.value
  if (!entry || !fixValid.value) return
  fixError.value = null
  try {
    await apiFetch(`/timeclock/entries/${entry.id}`, {
      method: 'PATCH',
      body: {
        // Only send the start when it actually moved — an untouched field should not appear
        // in the audit row as a change.
        ...(fixStartMoved.value ? { clockedInAt: new Date(fixStart.value).toISOString() } : {}),
        clockedOutAt: new Date(fixEnd.value).toISOString(),
        note: fixNote.value.trim(),
      },
    })
    fixing.value = null
    if (selectedId.value) await loadHours(selectedId.value)
  }
  catch (err) {
    fixError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  }
}

const tab = ref('overview')
watch(selectedId, (id) => {
  tab.value = 'overview'
  hours.value = null
  totals.value = null
  feed.value = []
  drawers.value = []
  historyFilter.value = 'all'
  if (id) void loadPerson(id)
}, { immediate: true })
watch(selectedId, (id) => {
  wageRates.value = []
  pay.value = null
  if (id) {
    void loadWage(id)
    void loadPay(id)
  }
}, { immediate: true })

watch([tab, range], () => {
  if (tab.value === 'hours' && selectedId.value) void loadHours(selectedId.value)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- ─────────────── INDEX ─────────────── -->
    <template v-if="!selected">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <h1 class="text-2xl font-extrabold tracking-tight">Staff</h1>
          <p class="text-sm text-muted-foreground">
            {{ visible.length }} {{ visible.length === 1 ? 'person' : 'people' }}<template
              v-if="needsAttention.length"
            >
              · {{ needsAttention.length }} need{{ needsAttention.length === 1 ? 's' : '' }} attention</template>
          </p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <Toggle :model-value="showInactive" @update:model-value="showInactive = $event">
            Show inactive
          </Toggle>
          <Button @click="startEdit(null)">Add staff</Button>
        </div>
      </div>

      <FieldError v-if="pageError">{{ pageError }}</FieldError>

      <!--
        The states that are WORK, above the table. A locked-out cashier is someone standing at
        a till right now unable to sign in; it should not need finding.
      -->
      <div
        v-if="needsAttention.length"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span
          v-for="p in needsAttention"
          :key="p.id"
          class="font-semibold"
        >
          {{ fullName(p) }} —
          {{ isLocked(p) ? `locked out until ${lockedUntilText(p)}` : 'PIN reset not yet used' }}
        </span>
      </div>

      <div class="relative">
        <div v-if="loading" class="absolute inset-0 z-10 bg-background/50" aria-hidden="true" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Last signed in</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="p in visible"
              :key="p.id"
              class="cursor-pointer"
              :class="p.active ? '' : 'opacity-60'"
              @click="open(p.id)"
            >
              <TableCell>
                <button
                  type="button"
                  class="flex items-center gap-2.5 text-left font-semibold hover:text-primary"
                  @click.stop="open(p.id)"
                >
                  <span
                    class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-muted-foreground"
                  >{{ initials(p) }}</span>
                  {{ fullName(p) }}
                </button>
              </TableCell>
              <TableCell class="text-muted-foreground">{{ p.role === 'ADMIN' ? 'Admin' : 'Staff' }}</TableCell>
              <TableCell class="text-muted-foreground">{{ p.store?.name ?? '—' }}</TableCell>
              <TableCell class="text-muted-foreground">{{ when(p.lastLoginAt) }}</TableCell>
              <TableCell>
                <Badge v-if="!p.active" class="border-transparent bg-muted text-muted-foreground">Deactivated</Badge>
                <Badge v-else-if="isLocked(p)" class="border-transparent bg-destructive/15 text-destructive">Locked out</Badge>
                <Badge v-else-if="p.mustChangePin" class="border-transparent bg-amber-500/15 text-amber-500">PIN reset pending</Badge>
                <Badge v-else-if="!p.hasPin" class="border-transparent bg-muted text-muted-foreground">No PIN</Badge>
                <Badge v-else class="border-transparent bg-primary/12 text-primary">Active</Badge>
              </TableCell>
            </TableRow>
            <TableEmpty v-if="!visible.length && !loading" :colspan="5">
              <Empty class="flex-none border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><UserX /></EmptyMedia>
                  <EmptyTitle>Nobody here yet</EmptyTitle>
                  <EmptyDescription>Add a staff member and they'll get a temporary PIN.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </TableEmpty>
          </TableBody>
        </Table>
      </div>
    </template>

    <!-- ─────────────── WORKSPACE ─────────────── -->
    <template v-else>
      <button
        type="button"
        class="w-fit text-sm text-muted-foreground hover:text-foreground"
        @click="open(null)"
      >
        ← All staff
      </button>

      <div class="flex flex-wrap items-start gap-3">
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-base font-extrabold text-muted-foreground"
        >{{ initials(selected) }}</span>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-extrabold tracking-tight">{{ fullName(selected) }}</h1>
          <p class="text-sm text-muted-foreground">
            {{ selected.role === 'ADMIN' ? 'Admin' : 'Staff' }}
            <template v-if="selected.store"> · {{ selected.store.name }}</template>
            <template v-if="selected.email"> · {{ selected.email }}</template>
          </p>
        </div>
        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="startEdit(selected)">Edit</Button>
          <Button variant="outline" :disabled="busy || !selected.active" @click="resetPin(selected)">
            Reset PIN
          </Button>
          <Button v-if="selected.active" variant="outline" class="text-destructive" :disabled="busy" @click="deactivating = selected; deactivateOpen = true">
            Deactivate
          </Button>
          <Button v-else :disabled="busy" @click="setActive(selected, true)">Reactivate</Button>
        </div>
      </div>

      <FieldError v-if="actionError">{{ actionError }}</FieldError>

      <div
        v-if="isLocked(selected)"
        class="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-4 py-2.5 text-sm text-destructive"
      >
        <span class="font-semibold">
          Locked out until {{ lockedUntilText(selected) }} after {{ selected.failedPinAttempts }} wrong PINs.
        </span>
        <Button size="sm" class="ml-auto" :disabled="busy" @click="clearLockout(selected)">
          Clear lockout
        </Button>
      </div>

      <div
        v-else-if="selected.mustChangePin"
        class="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span class="font-semibold">A temporary PIN is outstanding.</span>
        They'll be asked to choose a new one the next time they sign in at a register.
      </div>

      <Tabs v-model="tab">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger v-if="selected.role === 'STAFF'" value="hours">Hours</TabsTrigger>
          <TabsTrigger v-if="selected.role === 'STAFF'" value="pay">Pay</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" class="pt-4">
          <!--
            The counters live HERE rather than behind a tab (Kasan's B): they are the part
            anyone actually looks at, and Overview was two small boxes on a full-width page.
          -->
          <div v-if="totals" class="mb-4 flex flex-wrap gap-3">
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">{{ totals.saleCount }}</p>
              <p class="text-xs text-muted-foreground">Sales rung</p>
            </div>
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">{{ money(totals.grossCents) }}</p>
              <p class="text-xs text-muted-foreground">Gross</p>
            </div>
            <!--
              A dash, not $0.00, when there are no sales — the server returns null because an
              average over nothing is unanswerable. And it carries its sample size, the rule
              the suppliers scorecard set.
            -->
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums" :class="totals.averageSaleCents === null ? 'text-muted-foreground' : ''">
                {{ totals.averageSaleCents === null ? '—' : money(totals.averageSaleCents) }}
              </p>
              <p class="text-xs text-muted-foreground">
                Average sale<template v-if="totals.saleCount > 0"> · over {{ totals.saleCount }}</template>
              </p>
            </div>
            <!-- Custody, never hours. A drawer belongs to a store; hours live in the Hours tab. -->
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">
                {{ totals.drawersOpened }} / {{ totals.drawersClosed }}
              </p>
              <p class="text-xs text-muted-foreground">Drawers opened / closed</p>
            </div>
            <div v-if="totals.refundsIssued > 0 || totals.refundsApproved > 0" class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">
                {{ totals.refundsIssued }}<template v-if="totals.refundsApproved > 0"> / {{ totals.refundsApproved }}</template>
              </p>
              <p class="text-xs text-muted-foreground">
                Refunds issued<template v-if="totals.refundsApproved > 0"> / approved</template>
              </p>
            </div>
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">{{ totals.stockMovements }}</p>
              <p class="text-xs text-muted-foreground">Stock movements</p>
            </div>
          </div>

          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div class="rounded-xl border p-4">
              <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Identity</p>
              <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                <dt class="text-muted-foreground">Role</dt>
                <dd>{{ selected.role === 'ADMIN' ? 'Admin' : 'Staff' }}</dd>
                <dt class="text-muted-foreground">Store</dt>
                <dd>{{ selected.store?.name ?? 'No home store' }}</dd>
                <dt class="text-muted-foreground">Email</dt>
                <dd>{{ selected.email ?? '—' }}</dd>
                <dt class="text-muted-foreground">Added</dt>
                <dd>{{ new Date(selected.createdAt).toLocaleDateString() }}</dd>
              </dl>
            </div>

            <div class="rounded-xl border p-4">
              <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sign-in</p>
              <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                <dt class="text-muted-foreground">PIN</dt>
                <dd>{{ selected.hasPin ? (selected.mustChangePin ? 'Temporary' : 'Set') : 'None' }}</dd>
                <dt class="text-muted-foreground">Last signed in</dt>
                <dd>{{ when(selected.lastLoginAt) }}</dd>
                <dt class="text-muted-foreground">Failed attempts</dt>
                <dd :class="selected.failedPinAttempts > 0 ? 'text-destructive font-semibold' : ''">
                  {{ selected.failedPinAttempts }}
                </dd>
                <dt class="text-muted-foreground">Status</dt>
                <dd>{{ selected.active ? 'Active' : 'Deactivated' }}</dd>
              </dl>
            </div>

            <!--
              The wage sits with the other facts about a person rather than behind a tab —
              it is looked at the way Role and Store are. Admins have no wage: they are not
              on the clock, so they have no hours to pay for.
            -->
            <div v-if="selected.role === 'STAFF'" class="rounded-xl border p-4">
              <div class="mb-2 flex items-center gap-2">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Wage</p>
                <Button variant="outline" size="sm" class="ml-auto h-6 px-2 text-xs" @click="startWage">
                  {{ currentWage ? 'Change…' : 'Set a wage…' }}
                </Button>
              </div>

              <template v-if="currentWage">
                <p class="text-2xl font-bold tabular-nums">
                  {{ money(currentWage.ratePerHourCents)
                  }}<span class="text-sm font-medium text-muted-foreground">/hr</span>
                </p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  Since Sunday {{ payDay(currentWage.effectiveFromDate) }} · set by {{ currentWage.setByName }}
                </p>
                <p v-if="earlierWages.length" class="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Earlier ·
                  <span v-for="(r, i) in earlierWages.slice(0, 3)" :key="r.id">
                    <template v-if="i > 0">, </template>
                    <span class="tabular-nums">{{ money(r.ratePerHourCents) }}</span>
                    from {{ payDay(r.effectiveFromDate) }}
                  </span>
                </p>
              </template>
              <template v-else>
                <p class="text-sm text-amber-500">No hourly wage on file.</p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  Payroll cannot run a fortnight this person worked until one is set.
                </p>
              </template>
            </div>
          </div>

          <!--
            Said plainly rather than offered as a picker that would fail: moving between Admin
            and Staff rewrites three credential columns at once against three CHECK
            constraints, and there is no password-change endpoint to complete the Admin half.
          -->
          <p class="mt-4 text-xs text-muted-foreground">
            Role can't be changed here — Admin and Staff use different credentials
            (a password versus a PIN). Deactivate them and add them again under the other role.
          </p>
        </TabsContent>

        <!--
          The Pay tab (Kasan's pick B). Answers the question a person actually asks — "what
          have I been paid?" — from their own record rather than by opening six pay runs.

          ⚠️ Every figure is GROSS. Totals cover COMMITTED runs only; a reversed run was
          superseded and counting it would double what somebody earned.
        -->
        <TabsContent v-if="selected.role === 'STAFF'" value="pay" class="pt-4">
          <div v-if="pay && pay.lines.length" class="flex flex-col gap-4">
            <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <div class="rounded-xl border bg-card px-3.5 py-2.5">
                <div class="text-lg font-bold tabular-nums">
                  {{ currentWage ? perHour(currentWage.ratePerHourCents) : '—' }}
                </div>
                <div class="text-xs text-muted-foreground">Hourly wage</div>
                <div v-if="currentWage" class="mt-0.5 text-[11px] text-muted-foreground">
                  since Sun {{ payDay(currentWage.effectiveFromDate) }}
                </div>
              </div>
              <div class="rounded-xl border bg-card px-3.5 py-2.5">
                <div class="text-lg font-bold tabular-nums text-primary">{{ money(pay.paidCents) }}</div>
                <div class="text-xs text-muted-foreground">Paid</div>
                <div class="mt-0.5 text-[11px] text-muted-foreground">
                  of {{ money(pay.grossCents) }} gross
                </div>
              </div>
              <div class="rounded-xl border bg-card px-3.5 py-2.5">
                <div
                  class="text-lg font-bold tabular-nums"
                  :class="pay.outstandingCents > 0 ? 'text-amber-500' : 'text-muted-foreground'"
                >
                  {{ pay.outstandingCents > 0 ? money(pay.outstandingCents) : '—' }}
                </div>
                <div class="text-xs text-muted-foreground">Outstanding</div>
              </div>
            </div>

            <div class="rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead class="text-right">Hours</TableHead>
                    <TableHead class="text-right">Overtime</TableHead>
                    <TableHead class="text-right">Gross</TableHead>
                    <TableHead>Paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="l in pay.lines"
                    :key="l.payLineId"
                    :class="l.runStatus === 'REVERSED' ? 'opacity-50' : ''"
                  >
                    <TableCell>
                      <NuxtLink
                        :to="`/admin/payroll/${l.payRunId}`"
                        class="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {{ payDay(l.periodStartDate) }} – {{ payDay(l.periodEndDate) }}
                      </NuxtLink>
                      <span v-if="l.runStatus === 'REVERSED'" class="block text-xs text-red-400">Reversed</span>
                    </TableCell>
                    <TableCell class="text-right tabular-nums">{{ hm(l.totalMinutes) }}</TableCell>
                    <TableCell
                      class="text-right tabular-nums"
                      :class="l.overtimeMinutes > 0 ? 'text-amber-500' : 'text-muted-foreground'"
                    >
                      {{ l.overtimeMinutes > 0 ? hm(l.overtimeMinutes) : '—' }}
                    </TableCell>
                    <TableCell class="text-right font-semibold tabular-nums">{{ money(l.grossCents) }}</TableCell>
                    <TableCell>
                      <span
                        v-if="l.outstandingCents === 0"
                        class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary"
                      >{{ l.methods.length ? l.methods.map((m) => m[0] + m.slice(1).toLowerCase()).join(' + ') : 'Paid' }}</span>
                      <span
                        v-else-if="l.paidCents > 0"
                        class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-500"
                      >{{ money(l.paidCents) }} of {{ money(l.grossCents) }}</span>
                      <span
                        v-else
                        class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-500"
                      >Unpaid</span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <p class="text-xs text-muted-foreground">
              Gross, before any deductions — nothing here withholds tax.
            </p>
          </div>

          <Empty v-else class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Clock /></EmptyMedia>
              <EmptyTitle>Not on a pay run yet</EmptyTitle>
              <EmptyDescription>
                Pay runs are committed on the Payroll page, a fortnight at a time.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </TabsContent>


        <TabsContent v-if="selected.role === 'STAFF'" value="hours" class="pt-4">
          <div class="mb-4 flex flex-wrap items-center gap-3">
            <ToggleGroup
              :model-value="range"
              type="single"
              :spacing="2"
              aria-label="Date range"
              class="flex-wrap"
              @update:model-value="(v) => v && (range = v as typeof range)"
            >
              <ToggleGroupItem
                v-for="r in RANGES"
                :key="r.key"
                :value="r.key"
                class="inline-flex h-9 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
              >
                {{ r.label }}
              </ToggleGroupItem>
            </ToggleGroup>
            <Spinner v-if="hoursLoading" aria-hidden="true" class="text-muted-foreground" />
          </div>

          <!--
            ⚠️ TWO FIGURES, NEVER ONE. The server keeps `totalMinutes` and
            `estimatedMinutes` apart because an AUTO entry's end time is a guess it made at
            the cutoff when nobody clocked out. Adding them would put an invented number in
            someone's pay with nothing on screen saying so.
          -->
          <div v-if="hours" class="mb-4 flex flex-wrap gap-3">
            <div class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">{{ hm(hours.totalMinutes) }}</p>
              <p class="text-xs text-muted-foreground">Recorded</p>
            </div>
            <div
              v-if="hours.estimatedMinutes > 0"
              class="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3"
            >
              <p class="text-xl font-extrabold tabular-nums text-amber-600 dark:text-amber-400">
                {{ hm(hours.estimatedMinutes) }}
              </p>
              <p class="text-xs text-amber-600/80 dark:text-amber-400/80">Estimated</p>
            </div>
            <div v-if="hours.openCount > 0" class="rounded-xl border px-4 py-3">
              <p class="text-xl font-extrabold tabular-nums">{{ hours.openCount }}</p>
              <p class="text-xs text-muted-foreground">On the clock now</p>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead class="text-right">Hours</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="day in hourDays" :key="day.label">
                <TableRow class="bg-muted/40">
                  <TableCell colspan="5" class="font-semibold">
                    {{ day.label }} — {{ hm(day.minutes) }}<span
                      v-if="day.estimated > 0"
                      class="text-amber-600 dark:text-amber-400"
                    > + {{ hm(day.estimated) }} estimated</span>
                  </TableCell>
                </TableRow>
                <TableRow v-for="e in day.entries" :key="e.id">
                  <TableCell />
                  <TableCell class="tabular-nums">{{ clockTime(e.clockedInAt) }}</TableCell>
                  <TableCell class="tabular-nums">
                    <span v-if="!e.clockedOutAt" class="text-primary font-semibold">Still on the clock</span>
                    <span v-else :class="e.status === 'AUTO' ? 'text-amber-600 dark:text-amber-400' : ''">
                      {{ clockTime(e.clockedOutAt) }}<template v-if="e.status === 'AUTO'"> · estimated</template>
                      <template v-else-if="e.status === 'CORRECTED'"> · corrected</template>
                    </span>
                  </TableCell>
                  <TableCell
                    class="text-right tabular-nums"
                    :class="e.status === 'AUTO' ? 'text-amber-600 dark:text-amber-400' : ''"
                  >
                    {{ e.minutes === null ? '—' : hm(e.minutes) }}
                  </TableCell>
                  <TableCell class="text-right">
                    <Button
                      size="sm"
                      :variant="e.status === 'AUTO' ? 'default' : 'outline'"
                      @click="startFix(e)"
                    >
                      {{ e.status === 'AUTO' ? 'Fix' : 'Edit' }}
                    </Button>
                  </TableCell>
                </TableRow>
              </template>
              <TableEmpty v-if="!hourDays.length && !hoursLoading" :colspan="5">
                <Empty class="flex-none border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Clock /></EmptyMedia>
                    <EmptyTitle>No hours in this range</EmptyTitle>
                    <EmptyDescription>They clock in and out from a register.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableEmpty>
            </TableBody>
          </Table>

          <p
            v-if="hours && hours.estimatedMinutes > 0"
            class="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400"
          >
            Some entries have no clock-out and were closed at the 12-hour cutoff. Those hours
            are a guess until you set the real time.
          </p>
        </TabsContent>

        <!--
          ONE timeline, not a Drawers table and an Activity table. A typical cashier has four
          drawers and four audit rows — two half-empty tables, or one page worth reading. The
          chips are what compensates for two shapes of row sharing a list.
        -->
        <TabsContent value="history" class="pt-4">
          <div class="mb-4 flex flex-wrap items-center gap-3">
            <ToggleGroup
              :model-value="historyFilter"
              type="single"
              :spacing="2"
              aria-label="What to show"
              class="flex-wrap"
              @update:model-value="(v) => v && (historyFilter = v as typeof historyFilter)"
            >
              <ToggleGroupItem
                v-for="f in [
                  { key: 'all', label: 'Everything' },
                  { key: 'drawers', label: 'Drawers' },
                  { key: 'admin', label: 'Admin edits' },
                ]"
                :key="f.key"
                :value="f.key"
                class="inline-flex h-9 items-center rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=on]:border-solid data-[state=on]:border-primary/50 data-[state=on]:bg-transparent data-[state=on]:text-foreground"
              >
                {{ f.label }}
              </ToggleGroupItem>
            </ToggleGroup>
            <Spinner v-if="historyLoading" aria-hidden="true" class="text-muted-foreground" />
          </div>

          <div v-if="timelineDays.length" class="flex flex-col">
            <template v-for="day in timelineDays" :key="day.label">
              <p class="mt-4 border-b pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
                {{ day.label }}
              </p>
              <div
                v-for="item in day.items"
                :key="item.id"
                class="flex items-baseline gap-3 border-b py-2.5 text-sm"
              >
                <span
                  class="mt-1.5 size-2 shrink-0 rounded-full"
                  :class="item.kind === 'drawer' ? 'bg-amber-500' : 'bg-sky-500'"
                  aria-hidden="true"
                />
                <span class="w-20 shrink-0 tabular-nums text-muted-foreground">
                  {{ clockTime(item.at) }}
                </span>
                <span class="min-w-0 flex-1">{{ item.title }}</span>
                <span
                  class="shrink-0 text-xs tabular-nums"
                  :class="item.short ? 'font-semibold text-destructive' : 'text-muted-foreground'"
                >
                  {{ item.detail }}
                </span>
              </div>
            </template>
          </div>

          <Empty v-else-if="!historyLoading" class="flex-none border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Clock /></EmptyMedia>
              <EmptyTitle>Nothing recorded yet</EmptyTitle>
              <EmptyDescription>
                Drawers they opened or closed, and any changes they made in the back office,
                appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </TabsContent>
      </Tabs>
    </template>

    <!-- ─────────────── add / edit ─────────────── -->
    <Dialog :open="editorOpen" @update:open="(o: boolean) => !o && (editorOpen = false)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing ? 'Edit person' : 'Add staff' }}</DialogTitle>
          <DialogDescription>
            {{ editing
              ? 'Changing a store signs them out of tills at their old one.'
              : 'They get a temporary PIN, shown once, which they replace at their first sign-in.' }}
          </DialogDescription>
        </DialogHeader>

        <form novalidate @submit.prevent="save">
          <FieldGroup class="gap-4">
            <div class="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel for="st-first">First name</FieldLabel>
                <Input id="st-first" v-model="draft.firstName" autocomplete="off" autofocus />
              </Field>
              <Field>
                <FieldLabel for="st-last">Last name</FieldLabel>
                <Input id="st-last" v-model="draft.lastName" autocomplete="off" />
              </Field>
            </div>

            <Field :data-invalid="!!emailError">
              <FieldLabel for="st-email">
                Email <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input
                id="st-email"
                v-model="draft.email"
                type="email"
                autocomplete="off"
                :aria-invalid="!!emailError"
              />
              <FieldError v-if="emailError">{{ emailError }}</FieldError>
            </Field>

            <Field v-if="!editing || selected?.role !== 'ADMIN'">
              <FieldLabel for="st-store">Store</FieldLabel>
              <Select v-model="draft.storeId">
                <SelectTrigger id="st-store" class="w-full">
                  <SelectValue placeholder="Pick a store" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <FieldError v-if="editError">{{ editError }}</FieldError>
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="editorOpen = false">Cancel</Button>
          <Button type="button" :disabled="!canSave || saving" @click="save">
            {{ saving ? 'Saving…' : editing ? 'Save' : 'Add' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- ─────────────── the one-time PIN ─────────────── -->
    <Dialog :open="revealFor !== null" @update:open="(o: boolean) => !o && (revealFor = null)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Temporary PIN for {{ revealFor?.name }}</DialogTitle>
          <DialogDescription>
            They must change it the first time they sign in at a register.
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col items-center gap-3 py-2">
          <p class="font-mono text-4xl font-extrabold tracking-[0.2em] text-primary">
            {{ revealFor?.pin }}
          </p>
          <!--
            The same contract as a pairing code: returned in one response, stored only as an
            argon2 hash plus the HMAC lookup, never logged and never in the audit trail.
          -->
          <p class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs font-semibold text-amber-600 dark:text-amber-400">
            This is the only time it will be shown. Write it down or copy it now.
          </p>
          <Button variant="outline" class="w-full" @click="copyPin">
            {{ copied ? 'Copied' : 'Copy' }}
          </Button>
        </div>

        <DialogFooter>
          <Button @click="revealFor = null">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- ─────────────── correct a time entry ─────────────── -->
    <Dialog :open="fixing !== null" @update:open="(o: boolean) => !o && (fixing = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct this entry</DialogTitle>
          <DialogDescription>
            <template v-if="fixing?.status === 'AUTO'">
              Nobody clocked out, so this was closed at the 12-hour cutoff. The hours are a
              guess until you correct them.
            </template>
            <template v-else>Changing a recorded entry. It stays in the audit trail.</template>
          </DialogDescription>
        </DialogHeader>

        <!--
          A paid fortnight is closed to edits: payroll pays from this table, so changing an
          entry inside a committed run would leave the run no longer matching the hours it was
          worked out from. The one refusal with a specific remedy, so it names it.
        -->
        <div
          v-if="fixLocked"
          class="flex items-start gap-2.5 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2.5 text-sm"
        >
          <Lock class="mt-0.5 size-4 shrink-0 text-red-400" />
          <span>
            <b class="text-red-400">This fortnight has been paid.</b>
            Reverse the pay run for the fortnight from
            {{ fixing?.paidPeriodStartDate ? payDay(fixing.paidPeriodStartDate) : '' }} before changing the
            timesheet, or the run stops matching the hours it was worked out from.
          </span>
        </div>

        <FieldGroup v-else class="gap-4">
          <Field>
            <FieldLabel :for="fixStartOpen ? 'fix-start' : undefined">Clocked in at</FieldLabel>
            <!-- Shown as a fact until asked otherwise: the end time is what is nearly always
                 wrong, and presenting both equally invites editing the one that was right. -->
            <div v-if="!fixStartOpen" class="flex items-baseline gap-3">
              <span class="text-sm tabular-nums">
                {{ fixing ? new Date(fixing.clockedInAt).toLocaleString(undefined, {
                  weekday: 'short', day: 'numeric', month: 'short',
                  hour: 'numeric', minute: '2-digit',
                }) : '' }}
              </span>
              <button
                type="button"
                class="text-xs text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                @click="fixStartOpen = true"
              >
                Change
              </button>
            </div>
            <Input v-else id="fix-start" v-model="fixStart" type="datetime-local" />
          </Field>

          <Field>
            <FieldLabel for="fix-end">Clocked out at</FieldLabel>
            <Input id="fix-end" v-model="fixEnd" type="datetime-local" />
          </Field>

          <!--
            What the entry will be WORTH. On an estimated entry the figure being replaced is a
            twelve-hour guess, and with the start editable a mis-keyed date is silent — 08/11
            and 08/12 look alike and the difference is a day's pay.
          -->
          <div
            v-if="fixMinutes !== null"
            class="flex items-baseline gap-3 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2"
          >
            <span class="text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
              Hours recorded
            </span>
            <span
              v-if="fixWasMinutes !== null && fixWasMinutes !== fixMinutes"
              class="text-xs text-muted-foreground line-through tabular-nums"
            >{{ hm(fixWasMinutes) }}</span>
            <span class="ml-auto text-base font-bold tabular-nums text-primary">{{ hm(fixMinutes) }}</span>
          </div>

          <Field>
            <!-- The database refuses a correction without one: a changed timesheet with no
                 reason is not an audit trail, and this is what someone gets paid from. -->
            <FieldLabel for="fix-note">Reason</FieldLabel>
            <Input id="fix-note" v-model="fixNote" placeholder="e.g. She left at 4pm" autocomplete="off" />
            <FieldError v-if="fixError">{{ fixError }}</FieldError>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="ghost" @click="fixing = null">{{ fixLocked ? 'Close' : 'Cancel' }}</Button>
          <Button v-if="fixLocked" variant="outline" as-child>
            <NuxtLink :to="`/admin/payroll/${fixLocked}`">Open the pay run →</NuxtLink>
          </Button>
          <Button v-else :disabled="!fixValid" @click="saveFix">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- ─────────────── deactivate ─────────────── -->
    <AlertDialog v-model:open="deactivateOpen">
      <AlertDialogContent class="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {{ deactivating ? fullName(deactivating) : '' }}?</AlertDialogTitle>
          <AlertDialogDescription>
            They stop being able to sign in anywhere, immediately. Their sales, shifts and
            movements stay exactly as they are — nothing is deleted. You can reactivate them
            later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground" @click="confirmDeactivate">
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <p v-if="loading && !people.length" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" />Loading…
    </p>
  </div>

    <!--
      Setting a wage. The Sunday sentence is not decoration: a rate ALWAYS takes effect from
      the Sunday of the chosen week, which is what guarantees a workweek carries exactly one
      rate — and therefore that overtime never has to be computed against a blended rate.
    -->
    <Dialog :open="wageOpen" @update:open="(o: boolean) => !o && (wageOpen = false)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ currentWage ? 'Change the wage' : 'Set an hourly wage' }}</DialogTitle>
          <DialogDescription>
            {{ selected?.firstName }} {{ selected?.lastName }} · paid by the hour, before tax.
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-3">
          <Field>
            <FieldLabel for="wage-amount" class="text-xs">Hourly rate</FieldLabel>
            <InputGroup class="h-9">
              <InputGroupAddon class="text-xs">$</InputGroupAddon>
              <InputGroupInput
                id="wage-amount"
                v-model="wageAmount"
                inputmode="decimal"
                autocomplete="off"
                class="tabular-nums"
              />
              <InputGroupAddon align="inline-end" class="text-xs">/hr</InputGroupAddon>
            </InputGroup>
          </Field>

          <Field>
            <FieldLabel for="wage-from" class="text-xs">Effective from</FieldLabel>
            <Input id="wage-from" v-model="wageFrom" type="date" class="h-9" />
            <p v-if="wageSunday" class="text-xs text-muted-foreground">
              Takes effect <span class="font-medium text-foreground">Sunday {{ payDay(wageSunday) }}</span> —
              every hour that week pays at the new rate, so a week is never split across two rates.
            </p>
          </Field>

          <Field>
            <FieldLabel for="wage-note" class="text-xs">
              Note <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="wage-note" v-model="wageNote" autocomplete="off" maxlength="300" class="h-9" placeholder="Annual review…" />
          </Field>

          <FieldError v-if="wageError">{{ wageError }}</FieldError>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="wageOpen = false">Cancel</Button>
          <Button :disabled="!wageValid || wageSaving" @click="saveWage">
            {{ wageSaving ? 'Saving…' : 'Save wage' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
</template>
