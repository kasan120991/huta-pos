<script setup lang="ts">
import type { RosterEntry } from '@huta/shared/schemas'
import PinPad from '~/components/register/PinPad.vue'
import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'
import { FieldError } from '~/components/ui/field'

/**
 * Register sign-in: a grid of names, then a PIN keypad raised over it.
 *
 * The identity arrives separately from the PIN, and that is not a UX preference — it is
 * what makes the per-person lockout possible at all. A bare PIN would be looked up by its
 * HMAC, so a wrong one would match no user and there would be no account to count the
 * failure against.
 *
 * The keypad is touch-first but a KEYBOARD ALWAYS WORKS: a window-level listener feeds
 * the same model while the overlay is open (digits, Backspace, Escape) — no field needs
 * focus, which also keeps barcode scanners harmless here.
 */
definePageMeta({ layout: 'register' })

const PIN_LENGTH = 4

const auth = useAuthStore()
const router = useRouter()

const staff = ref<RosterEntry[]>([])
const loadingRoster = ref(true)
const rosterError = ref<string | null>(null)

const selected = ref<RosterEntry | null>(null)
const pin = ref('')
const submitting = ref(false)
const pinError = ref<string | null>(null)
const lockedSeconds = ref<number | null>(null)

const lockoutMessage = computed(() => {
  if (lockedSeconds.value === null) return null
  const minutes = Math.max(1, Math.ceil(lockedSeconds.value / 60))
  return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask a manager to unlock you.`
})

onMounted(async () => {
  if (!auth.resolved) await auth.fetchPrincipal()
  // Already attached — nothing to sign into.
  if (auth.isAtTerminal && auth.user) {
    await router.replace('/register')
    return
  }
  await loadRoster()
})

async function loadRoster() {
  loadingRoster.value = true
  rosterError.value = null
  try {
    staff.value = await auth.fetchRoster()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The device token is gone or the terminal was deactivated — this register has to
      // be paired again before anyone can sign in.
      await router.replace('/register/pair')
      return
    }
    rosterError.value = error instanceof ApiError ? error.message : 'Could not reach the server.'
  } finally {
    loadingRoster.value = false
  }
}

function choose(person: RosterEntry) {
  selected.value = person
  pin.value = ''
  pinError.value = null
  lockedSeconds.value = null
}

function dismiss() {
  selected.value = null
  pin.value = ''
  pinError.value = null
  lockedSeconds.value = null
}

// Clear the stale error as soon as they start over, rather than leaving "not recognised"
// sitting under a fresh attempt.
watch(pin, (value) => {
  if (value.length > 0 && pinError.value) pinError.value = null
})

async function attach(value: string) {
  const person = selected.value
  if (!person || submitting.value) return
  submitting.value = true
  try {
    await auth.attach(person.userId, value)
    await router.push('/register')
  } catch (error) {
    pin.value = ''
    if (!(error instanceof ApiError)) {
      pinError.value = 'Could not reach the server.'
      return
    }
    if (error.code === 'ACCOUNT_LOCKED') {
      lockedSeconds.value = error.retryAfterSeconds ?? 900
    } else {
      // 401 — one generic message whether the PIN was wrong or the person is not
      // permitted at this store. RATE_LIMITED surfaces its own message the same way.
      pinError.value = error.message
    }
  } finally {
    submitting.value = false
  }
}

/* ————— physical keyboard, active only while the overlay is up ————— */
function onKeydown(event: KeyboardEvent) {
  if (!selected.value) return
  if (event.key >= '0' && event.key <= '9') {
    event.preventDefault()
    if (submitting.value || pin.value.length >= PIN_LENGTH) return
    pin.value += event.key
    if (pin.value.length === PIN_LENGTH) void attach(pin.value)
  } else if (event.key === 'Backspace') {
    event.preventDefault()
    if (!submitting.value) pin.value = pin.value.slice(0, -1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (!submitting.value) dismiss()
  }
}

watch(selected, (open) => {
  if (open) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const initials = (p: RosterEntry) => `${p.firstName.charAt(0)}${p.lastInitial}`.toUpperCase()
const displayName = (p: RosterEntry) => `${p.firstName} ${p.lastInitial}.`
</script>

<template>
  <div class="flex flex-1 flex-col">
    <RegisterBar />
    <div class="flex flex-1 flex-col items-center px-8 pt-10">
      <h1 class="text-2xl font-extrabold tracking-tight">Who's signing in?</h1>

      <FieldError v-if="rosterError" class="mt-8">
        {{ rosterError }}
        <button type="button" class="ml-2 underline underline-offset-2" @click="loadRoster">Retry</button>
      </FieldError>
      <p v-else-if="loadingRoster" class="mt-8 text-sm text-muted-foreground">Loading roster…</p>
      <p v-else-if="!staff.length" class="mt-8 max-w-sm text-center text-sm text-muted-foreground">
        Nobody can sign in at this store yet — add staff in the back office.
      </p>

      <div v-else class="mt-8 grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
        <button
          v-for="person in staff"
          :key="person.userId"
          type="button"
          class="flex h-28 w-36 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
          @click="choose(person)"
        >
          <span class="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
            {{ initials(person) }}
          </span>
          <span class="text-sm font-semibold">{{ displayName(person) }}</span>
        </button>
      </div>
    </div>

    <!-- PIN overlay -->
    <div
      v-if="selected"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      :aria-label="`Enter PIN for ${displayName(selected)}`"
      @click.self="!submitting && dismiss()"
    >
      <div class="flex flex-col items-center gap-5 rounded-3xl border bg-card px-10 py-8 shadow-2xl">
        <div class="flex items-center gap-2.5 text-base font-bold">
          <span class="flex size-8 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
            {{ initials(selected) }}
          </span>
          {{ displayName(selected) }}
        </div>

        <PinPad
          v-model="pin"
          :max-length="PIN_LENGTH"
          :disabled="submitting || lockedSeconds !== null"
          @complete="attach"
        />

        <p v-if="lockoutMessage" role="alert" class="max-w-64 text-center text-sm text-amber-500">
          {{ lockoutMessage }}
        </p>
        <FieldError v-else-if="pinError">{{ pinError }}</FieldError>
        <p v-else-if="submitting" class="text-sm text-muted-foreground">Checking…</p>

        <button
          type="button"
          class="text-sm text-muted-foreground underline-offset-2 hover:underline"
          :disabled="submitting"
          @click="dismiss"
        >
          Not {{ selected.firstName }}? Go back
        </button>
      </div>
    </div>
  </div>
</template>
