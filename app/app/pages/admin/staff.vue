<script setup lang="ts">
import type { CatalogReference, StaffAdminRow } from '@huta/shared/schemas'
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
import { ApiError, apiFetch } from '~/composables/useApi'
import { UserX } from '@lucide/vue'

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
const deactivating = ref<StaffAdminRow | null>(null)

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
  deactivating.value = null
  if (person) void setActive(person, false)
}

const tab = ref('overview')
watch(selectedId, () => (tab.value = 'overview'))
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
          <Button v-if="selected.active" variant="outline" class="text-destructive" :disabled="busy" @click="deactivating = selected">
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
        </TabsList>

        <TabsContent value="overview" class="pt-4">
          <div class="grid gap-4 md:grid-cols-2">
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

    <!-- ─────────────── deactivate ─────────────── -->
    <AlertDialog :open="deactivating !== null" @update:open="(o: boolean) => !o && (deactivating = null)">
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
</template>
