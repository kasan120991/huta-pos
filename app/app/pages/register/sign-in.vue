<script setup lang="ts">
import type { RosterEntry } from '@huta/shared/schemas'
import PinPad from '~/components/register/PinPad.vue'
import { ApiError, apiFetch } from '~/composables/useApi'
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

/**
 * Anyone may work at any store since 2026-08-22, but this screen is readable by whoever is
 * standing at the till, with no login — so it shows THIS STORE's team by default and fetches
 * the rest only when someone asks.
 *
 * The extra people are APPENDED under a divider rather than replacing the grid: the local team
 * keeps its position, so nobody loses the tile they were already reaching for.
 */
const visiting = ref<RosterEntry[]>([])
const loadingVisiting = ref(false)
/**
 * Whether the visiting list has been ASKED for — deliberately not `visiting.length > 0`.
 * Deriving it from the array makes "nobody else exists" indistinguishable from "not asked
 * yet", so tapping the link when everyone is already local would appear to do nothing.
 */
const visitingShown = ref(false)

async function showVisiting() {
  if (loadingVisiting.value || visitingShown.value) return
  loadingVisiting.value = true
  rosterError.value = null
  try {
    const everyone = await auth.fetchRoster('all')
    // Whoever is not already on the local grid. Subtracting by id needs no extra field on
    // the payload, and the payload deliberately carries nothing but a name.
    const here = new Set(staff.value.map((p) => p.userId))
    visiting.value = everyone.filter((p) => !here.has(p.userId))
    visitingShown.value = true
  } catch (error) {
    rosterError.value = error instanceof ApiError ? error.message : 'Could not reach the server.'
  } finally {
    loadingVisiting.value = false
  }
}

async function loadRoster() {
  loadingRoster.value = true
  rosterError.value = null
  visiting.value = []
  visitingShown.value = false
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

/**
 * The change-PIN step.
 *
 * An admin who resets someone's PIN gets a temporary one, and `attachByPin` REFUSES it with
 * PIN_CHANGE_REQUIRED rather than opening a session — otherwise the admin would hold a
 * working credential for that person, in the system whose whole job is attribution. So this
 * is not an optional nicety: without it a reset person cannot sign in at all.
 *
 * `stage` drives the one overlay: enter the temporary PIN, then the new one, then confirm it.
 */
type Stage = 'pin' | 'new' | 'confirm'
const stage = ref<Stage>('pin')
const tempPin = ref('')
const newPin = ref('')

function choose(person: RosterEntry) {
  selected.value = person
  pin.value = ''
  pinError.value = null
  lockedSeconds.value = null
  stage.value = 'pin'
  tempPin.value = ''
  newPin.value = ''
}

function dismiss() {
  selected.value = null
  pin.value = ''
  pinError.value = null
  lockedSeconds.value = null
  stage.value = 'pin'
  tempPin.value = ''
  newPin.value = ''
}

// Clear the stale error as soon as they start over, rather than leaving "not recognised"
// sitting under a fresh attempt.
watch(pin, (value) => {
  if (value.length > 0 && pinError.value) pinError.value = null
})

/** Where a completed pad entry goes, depending on which step we are on. */
function onComplete(value: string) {
  if (stage.value === 'pin') return void attach(value)
  if (stage.value === 'new') {
    newPin.value = value
    pin.value = ''
    stage.value = 'confirm'
    return
  }
  if (value !== newPin.value) {
    pin.value = ''
    newPin.value = ''
    stage.value = 'new'
    pinError.value = 'Those did not match. Choose a new PIN again.'
    return
  }
  void submitNewPin(value)
}

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
    if (error.code === 'PIN_CHANGE_REQUIRED') {
      // The temporary PIN was right. Keep it — the change endpoint re-proves it, which is
      // what reuses the lockout machinery instead of inventing a second credential path.
      tempPin.value = value
      stage.value = 'new'
      pinError.value = null
    } else if (error.code === 'ACCOUNT_LOCKED') {
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

async function submitNewPin(value: string) {
  const person = selected.value
  if (!person || submitting.value) return
  submitting.value = true
  try {
    await apiFetch('/auth/staff/pin-change', {
      method: 'POST',
      body: { userId: person.userId, currentPin: tempPin.value, newPin: value },
    })
  } catch (error) {
    pin.value = ''
    newPin.value = ''
    stage.value = 'new'
    pinError.value
      = error instanceof ApiError ? error.message : 'Could not reach the server.'
    return
  } finally {
    submitting.value = false
  }

  // ⚠️ OUTSIDE the try, and after `submitting` has been released, deliberately. `attach`
  // opens with its own re-entrancy guard — `if (!person || submitting.value) return` — so
  // calling it while this function still held the flag made it silently no-op: the PIN
  // changed, and the register sat on the confirm step as though nothing had happened.
  //
  // One path mints a session and this is not it; the person signs in normally, with the
  // PIN they just chose.
  await attach(value)
}

/* ————— physical keyboard, active only while the overlay is up ————— */
function onKeydown(event: KeyboardEvent) {
  if (!selected.value) return
  if (event.key >= '0' && event.key <= '9') {
    event.preventDefault()
    if (submitting.value || pin.value.length >= PIN_LENGTH) return
    pin.value += event.key
    if (pin.value.length === PIN_LENGTH) onComplete(pin.value)
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
      <p v-else-if="!staff.length && !visitingShown" class="mt-8 max-w-sm text-center text-sm text-muted-foreground">
        Nobody is based at this store yet. Someone from the other store can still sign in below,
        or add staff in the back office.
      </p>

      <div v-if="staff.length" class="mt-8 grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
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

      <!--
        The exception, rendered as one: a line of text rather than a tile, so every tile above
        stays a person. Generous padding because a text link is a poor touch target and this is
        a touchscreen — `py-3 px-4` gives it a 44px-tall hit area.
      -->
      <button
        v-if="!loadingRoster && !rosterError && !visitingShown"
        type="button"
        class="mt-5 rounded-lg px-4 py-3 text-sm text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        @click="showVisiting"
      >
        {{ loadingVisiting ? 'Looking…' : 'Working here from another store?' }}
      </button>

      <template v-if="visitingShown">
        <div class="mt-7 flex w-full max-w-2xl items-center gap-3">
          <span class="h-px flex-1 bg-border" />
          <span class="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
            Visiting today
          </span>
          <span class="h-px flex-1 bg-border" />
        </div>

        <div class="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
          <button
            v-for="person in visiting"
            :key="person.userId"
            type="button"
            class="flex h-28 w-36 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
            @click="choose(person)"
          >
            <!-- Muted, not green: these are the people who do NOT normally stand here. -->
            <span class="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground">
              {{ initials(person) }}
            </span>
            <span class="text-sm font-semibold">{{ displayName(person) }}</span>
          </button>
        </div>

        <p v-if="!visiting.length" class="mt-4 text-sm text-muted-foreground">
          Everyone who can sign in is already listed above.
        </p>
      </template>
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

        <p v-if="stage !== 'pin'" class="max-w-64 text-center text-sm font-semibold">
          {{ stage === 'new'
            ? 'That PIN was temporary. Choose a new one.'
            : 'Enter it once more to confirm.' }}
        </p>

        <PinPad
          v-model="pin"
          :max-length="PIN_LENGTH"
          :disabled="submitting || lockedSeconds !== null"
          @complete="onComplete"
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
