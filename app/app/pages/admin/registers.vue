<script setup lang="ts">
import type { CatalogReference } from '@huta/shared/schemas'
import type { PairingCodeIssued, TerminalAdminRow } from '@huta/shared/schemas'
import { MonitorSmartphone, Pencil, Plus } from '@lucide/vue'
import { Spinner } from '~/components/ui/spinner'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Badge } from '~/components/ui/badge'
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

/**
 * The Registers desk: every terminal per store, pairing codes without psql, and the
 * revocation switch. The code shows ONCE, big, with a live countdown — generating a new
 * one voids the old (server rule).
 */

const terminals = ref<TerminalAdminRow[]>([])
const reference = ref<CatalogReference | null>(null)
const loading = ref(true)
const actionError = ref<string | null>(null)

async function fetchTerminals() {
  const data = await apiFetch<{ terminals: TerminalAdminRow[] }>('/auth/terminals')
  terminals.value = data.terminals
}

onMounted(async () => {
  try {
    await fetchTerminals()
    reference.value = await apiFetch<CatalogReference>('/catalog/reference')
  } finally {
    loading.value = false
  }
})

/** Grouped by store, every ACTIVE store appearing even when it has no terminals yet. */
const groups = computed(() => {
  const byStore = new Map<string, { id: string, name: string, terminals: TerminalAdminRow[] }>()
  for (const store of reference.value?.stores ?? []) {
    byStore.set(store.id, { id: store.id, name: store.name, terminals: [] })
  }
  for (const terminal of terminals.value) {
    const group = byStore.get(terminal.store.id)
    if (group) group.terminals.push(terminal)
    else byStore.set(terminal.store.id, { ...terminal.store, terminals: [terminal] })
  }
  return [...byStore.values()]
})

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

function lastSeen(row: TerminalAdminRow): string {
  if (!row.lastSeenAt) return `Created ${dateFmt.format(new Date(row.createdAt))} · waiting for its first pairing`
  const seen = new Date(row.lastSeenAt)
  const today = new Date().toDateString() === seen.toDateString()
  return `Last seen ${today ? `today · ${timeFmt.format(seen)}` : dateFmt.format(seen)}`
}

function statusOf(row: TerminalAdminRow): { label: string, on: boolean } {
  if (!row.active) return { label: 'Deactivated', on: false }
  if (!row.lastSeenAt) return { label: 'Never paired', on: false }
  return { label: 'Active', on: true }
}

/* ————— pairing code ————— */
const codeFor = ref<TerminalAdminRow | null>(null)
const issued = ref<PairingCodeIssued | null>(null)
const generating = ref(false)
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

const remaining = computed(() => {
  if (!issued.value) return null
  const ms = new Date(issued.value.expiresAt).getTime() - now.value
  if (ms <= 0) return 'Expired — generate a new one'
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
})

async function generateCode(terminal: TerminalAdminRow) {
  codeFor.value = terminal
  issued.value = null
  actionError.value = null
  generating.value = true
  try {
    issued.value = await apiFetch<PairingCodeIssued>('/auth/terminal/pairing-code', {
      method: 'POST',
      body: { terminalId: terminal.id },
    })
    now.value = Date.now()
    clearInterval(ticker)
    ticker = setInterval(() => { now.value = Date.now() }, 1000)
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    generating.value = false
  }
}

function closeCode() {
  codeFor.value = null
  issued.value = null
  clearInterval(ticker)
}
onUnmounted(() => clearInterval(ticker))

/* ————— new register ————— */
const newOpen = ref(false)
const newName = ref('')
const newStoreId = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

function openNew(storeId?: string) {
  newOpen.value = true
  newName.value = ''
  newStoreId.value = storeId ?? reference.value?.stores[0]?.id ?? ''
  createError.value = null
}

async function createRegister() {
  if (!newName.value.trim() || !newStoreId.value || creating.value) return
  creating.value = true
  createError.value = null
  try {
    const created = await apiFetch<TerminalAdminRow>('/auth/terminals', {
      method: 'POST',
      body: { name: newName.value.trim(), storeId: newStoreId.value },
    })
    await fetchTerminals()
    newOpen.value = false
    // Straight into the pairing moment — creating a register exists to pair it.
    await generateCode(created)
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    creating.value = false
  }
}

/* ————— rename (inline) ————— */
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renaming = ref(false)

function startRename(row: TerminalAdminRow) {
  renamingId.value = row.id
  renameValue.value = row.name
}

async function saveRename(row: TerminalAdminRow) {
  const name = renameValue.value.trim()
  if (!name || renaming.value) return
  if (name === row.name) {
    renamingId.value = null
    return
  }
  renaming.value = true
  try {
    await apiFetch(`/auth/terminals/${row.id}`, { method: 'PATCH', body: { name } })
    await fetchTerminals()
    renamingId.value = null
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    renaming.value = false
  }
}

/* ————— activate / deactivate ————— */
/**
 * ⚠️ The dialog's OPEN state is a separate ref from the row it is about, and that separation
 * is load-bearing.
 *
 * reka's `AlertDialogAction` closes the dialog on click, and that close fires `@update:open`
 * BEFORE the fallthrough `@click` runs. When one ref did both jobs, the close nulled it and
 * `deactivateTarget && setActive(deactivateTarget, false)` short-circuited to nothing — no
 * request, no error, dialog shut. Deactivating a register silently did nothing.
 *
 * Keeping the row after the close is harmless: it is only read by the action and by the
 * title, and the title is only on screen while `deactivateOpen` is true.
 */
const deactivateTarget = ref<TerminalAdminRow | null>(null)
const deactivateOpen = ref(false)
const toggling = ref(false)

function askDeactivate(row: TerminalAdminRow) {
  deactivateTarget.value = row
  deactivateOpen.value = true
}

async function setActive(row: TerminalAdminRow, active: boolean) {
  if (toggling.value) return
  toggling.value = true
  actionError.value = null
  try {
    await apiFetch(`/auth/terminals/${row.id}`, { method: 'PATCH', body: { active } })
    await fetchTerminals()
    deactivateOpen.value = false
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    toggling.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-2">
      <h1 class="text-xl font-semibold tracking-tight">Registers</h1>
      <span class="text-sm text-muted-foreground">{{ terminals.length }} terminals</span>
    </div>

    <FieldError v-if="actionError">{{ actionError }}</FieldError>
    <p v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" />Loading…
    </p>

    <section v-for="group in groups" :key="group.id" class="flex flex-col gap-2">
      <h2 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ group.name }}
      </h2>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="row in group.terminals"
          :key="row.id"
          class="flex flex-col gap-2 rounded-xl border bg-card p-3.5"
        >
          <div class="flex items-center gap-2">
            <template v-if="renamingId === row.id">
              <Input
                v-model="renameValue"
                class="h-8 text-sm font-semibold"
                autocomplete="off"
                autofocus
                :aria-label="`New name for ${row.name}`"
                @keydown.enter.prevent="saveRename(row)"
                @keydown.escape="renamingId = null"
              />
              <Button size="sm" class="h-8 px-2.5 text-xs" :disabled="renaming" @click="saveRename(row)">Save</Button>
              <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="renamingId = null">Cancel</Button>
            </template>
            <template v-else>
              <MonitorSmartphone class="size-4 text-muted-foreground" />
              <span class="truncate text-sm font-semibold">{{ row.name }}</span>
              <Badge v-if="statusOf(row).on" class="border-transparent bg-primary/10 text-primary">Active</Badge>
              <Badge v-else variant="secondary">{{ statusOf(row).label }}</Badge>
            </template>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ row.active && !row.lastSeenAt ? lastSeen(row) : row.active ? lastSeen(row) : `${lastSeen(row)} · device token revoked` }}
          </p>
          <div class="mt-1 flex flex-wrap items-center gap-1.5">
            <template v-if="row.active">
              <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" @click="generateCode(row)">
                Generate pairing code
              </Button>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" @click="startRename(row)">
                <Pencil class="size-3" /> Rename
              </Button>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" @click="askDeactivate(row)">
                Deactivate
              </Button>
            </template>
            <template v-else>
              <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" :disabled="toggling" @click="setActive(row, true)">
                Reactivate
              </Button>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" @click="startRename(row)">
                <Pencil class="size-3" /> Rename
              </Button>
            </template>
          </div>
        </div>

        <button
          type="button"
          class="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          @click="openNew(group.id)"
        >
          <Plus class="size-4" /> New register
        </button>
      </div>
    </section>

    <!-- pairing code -->
    <Dialog :open="codeFor !== null" @update:open="(o: boolean) => !o && closeCode()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pair "{{ codeFor?.name }}"</DialogTitle>
          <DialogDescription>{{ codeFor?.store.name }}</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col items-center gap-3 py-2">
          <p v-if="generating" class="text-sm text-muted-foreground">Generating…</p>
          <template v-else-if="issued">
            <div class="font-mono text-5xl font-bold tracking-[0.12em] text-primary">{{ issued.code }}</div>
            <p class="text-sm text-muted-foreground">
              <template v-if="remaining && !remaining.startsWith('Expired')">
                Expires in <span class="font-semibold text-foreground tabular-nums">{{ remaining }}</span> · works once
              </template>
              <template v-else>{{ remaining }}</template>
            </p>
            <p class="max-w-72 text-center text-xs text-muted-foreground">
              On the new register, open <span class="font-medium text-foreground">/register/pair</span> and type
              this code. Generating a new code makes this one useless.
            </p>
          </template>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="generating" @click="codeFor && generateCode(codeFor)">
            Generate a new code
          </Button>
          <Button @click="closeCode">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- new register -->
    <Dialog :open="newOpen" @update:open="(o: boolean) => !o && (newOpen = false)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New register</DialogTitle>
          <DialogDescription>Pairing comes next.</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" novalidate @submit.prevent="createRegister">
          <Field>
            <FieldLabel for="nr-name">Name</FieldLabel>
            <Input id="nr-name" v-model="newName" placeholder="Register 2" autocomplete="off" autofocus />
          </Field>
          <Field>
            <FieldLabel for="nr-store">Store</FieldLabel>
            <Select v-model="newStoreId">
              <SelectTrigger id="nr-store" class="w-full"><SelectValue placeholder="Pick a store" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="store in reference?.stores ?? []" :key="store.id" :value="store.id">
                  {{ store.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <FieldError v-if="createError">{{ createError }}</FieldError>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="newOpen = false">Cancel</Button>
            <Button type="submit" :disabled="creating || !newName.trim() || !newStoreId">
              {{ creating ? 'Creating…' : 'Create & get pairing code' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- deactivate confirm -->
    <!--
      An AlertDialog, not a Dialog: role="alertdialog", focus lands on the safe choice, and
      it will not dismiss on a stray click outside or on Escape. The action closes it on
      click, so a failure surfaces on the page behind rather than behind a stuck dialog —
      which is what used to happen.
    -->
    <AlertDialog v-model:open="deactivateOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {{ deactivateTarget?.name }}?</AlertDialogTitle>
          <AlertDialogDescription>
            It signs out immediately. Reactivate any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            class="border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
            :disabled="toggling"
            @click="deactivateTarget && setActive(deactivateTarget, false)"
          >
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
