<script setup lang="ts">
import type { RosterEntry } from '@huta/shared/schemas'
import { computed, onMounted, ref, watch } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/**
 * Register sign-in: a grid of names, then a PIN keypad raised over it.
 *
 * The identity arrives separately from the PIN, and that is not a UX preference — it is
 * what makes the per-person lockout possible at all. A bare PIN would be looked up by its
 * HMAC, so a wrong one would match no user and there would be no account to count the
 * failure against.
 */

definePageMeta({ layout: 'register' })

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

onMounted(loadRoster)

async function loadRoster(): Promise<void> {
  loadingRoster.value = true
  rosterError.value = null
  try {
    staff.value = await auth.fetchRoster()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The device token is gone or the terminal was deactivated — this register has to
      // be paired again before anyone can sign in.
      await router.push('/register/pair')
      return
    }
    rosterError.value =
      error instanceof ApiError ? error.message : 'Could not reach the server.'
  } finally {
    loadingRoster.value = false
  }
}

function choose(person: RosterEntry): void {
  selected.value = person
  pin.value = ''
  pinError.value = null
  lockedSeconds.value = null
}

function dismiss(): void {
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

async function attach(value: string): Promise<void> {
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
    } else if (error.code === 'RATE_LIMITED') {
      pinError.value = error.message
    } else {
      // 401 — one generic message whether the PIN was wrong or the person is not
      // permitted at this store.
      pinError.value = error.message
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="signin">
    <header class="bar">
      <HutaMark />
      <!-- Which register this IS — how a mis-paired machine gets noticed at a glance,
           rather than at opening when the wrong store's roster comes up. -->
      <span v-if="auth.registerLabel" class="whereami">{{ auth.registerLabel }}</span>
    </header>

    <div class="body">
      <h1>Who's signing in?</h1>

      <div v-if="loadingRoster" class="muted">Loading…</div>

      <Message v-else-if="rosterError" severity="error" :closable="false">
        {{ rosterError }}
      </Message>

      <div v-else-if="staff.length === 0" class="muted empty">
        <p>Nobody at this store has a PIN yet.</p>
        <p class="small">An admin sets PINs from the back office.</p>
      </div>

      <div v-else class="tiles">
        <StaffTile
          v-for="person in staff"
          :key="person.userId"
          :first-name="person.firstName"
          :last-initial="person.lastInitial"
          @click="choose(person)"
        />
      </div>
    </div>

    <!-- PIN overlay. Raised over the roster so the keypad gets the whole screen's
         attention; dismissing returns to the grid without a page change. -->
    <div v-if="selected" class="overlay" role="dialog" aria-modal="true" aria-label="Enter your PIN">
      <div class="pad-card">
        <div class="who">
          <span class="initials" aria-hidden="true">
            {{ selected.firstName.charAt(0) }}{{ selected.lastInitial }}
          </span>
          <span class="nm">{{ selected.firstName }} {{ selected.lastInitial }}.</span>
        </div>

        <Message v-if="lockoutMessage" severity="warn" :closable="false">
          {{ lockoutMessage }}
        </Message>
        <Message v-else-if="pinError" severity="error" :closable="false">
          {{ pinError }}
        </Message>

        <PinKeypad
          v-model="pin"
          :max-length="4"
          :disabled="submitting || lockedSeconds !== null"
          @complete="attach"
          @cancel="dismiss"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.signin {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 100dvh;
  position: relative;
}

.bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem 1.75rem;
}

.bar :deep(.leaf) {
  color: var(--p-primary-color);
}

.whereami {
  margin-left: auto;
  font-size: 0.9375rem;
  color: var(--p-text-muted-color);
}

.body {
  align-content: center;
  justify-items: center;
  display: grid;
  gap: 2rem;
  padding: 0 clamp(1.5rem, 4vw, 4rem) 6rem;
}

h1 {
  margin: 0;
  font-size: 1.75rem;
  letter-spacing: -0.015em;
  text-align: center;
}

/*
 * Capped and centred rather than stretched across the full 1920. `auto-fill` on a bare
 * full-width grid left a two-person roster huddled in the top-left corner of an otherwise
 * empty screen; a max width of four columns keeps a small team centred and a large one
 * reflowing downward, without ever shrinking a tap target.
 */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 15rem));
  justify-content: center;
  gap: 1.25rem;
  width: 100%;
  max-width: 64rem;
}

.muted {
  color: var(--p-text-muted-color);
}

.empty p {
  margin: 0 0 0.25rem;
}

.small {
  font-size: 0.875rem;
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  /*
   * `place-items`, NOT `place-content`. place-content sizes the grid track to its content,
   * so the card's `min(30rem, 100%)` had no definite width to resolve `100%` against and
   * collapsed to the intrinsic width of the keypad — making the card narrower the more we
   * tried to widen it. place-items keeps the track full-bleed and centres the card in it.
   */
  place-items: center;
  padding: 1.5rem;
  background: color-mix(in srgb, var(--p-surface-100) 80%, transparent);
  backdrop-filter: blur(4px);
}

.app-dark .overlay {
  background: color-mix(in srgb, var(--p-surface-950) 82%, transparent);
}

/*
 * Sized for a thumb on a 1920-wide screen, not for a mouse. At 23rem the card was ~19% of
 * the display and the keys came out taller than they were wide, which reads as cramped on
 * a register even though it would be fine in a browser window.
 */
.pad-card {
  width: min(30rem, 100%);
  display: grid;
  gap: 1.5rem;
  justify-items: center;
  padding: 2.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 1rem;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 24px 48px -20px rgb(0 0 0 / 0.3);
}

.who {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
}

.who .initials {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
  display: grid;
  place-content: center;
  font-weight: 640;
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
}

.who .nm {
  font-size: 1.125rem;
  font-weight: 580;
}
</style>
