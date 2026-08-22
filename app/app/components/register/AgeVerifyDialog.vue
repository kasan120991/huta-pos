<script setup lang="ts">
import { Delete } from '@lucide/vue'
import { Button } from '~/components/ui/button'

/**
 * The 21+ check at the register (Kasan's V3 pick, 2026-08-21) — cutoff first.
 *
 * The screen leads with the only figure that decides the sale: the latest birth date that
 * passes today. Staff read it, glance at the licence, and key the date underneath.
 *
 * THE DATE OF BIRTH IS NEVER SENT ANYWHERE. It is arithmetic held in this component for as
 * long as the dialog is open, and what the parent records on the sale is the same
 * `ageVerified` flag and attesting cashier the old checkbox wrote. That is deliberate:
 * sales are append-only and never deleted, so a stored DOB would be permanent customer PII
 * with no retention policy. Changing that is a schema decision, not a screen decision.
 *
 * Under 21 is a HARD STOP — `confirm` is never emitted, so the cart stays unverified and
 * checkout keeps 409-ing server-side. There is no "proceed anyway".
 */
const props = defineProps<{
  open: boolean
  /** Shown in the confirmation line so the attestation names who is attesting. */
  cashierName?: string | undefined
}>()

const emit = defineEmits<{ confirm: [age: number], close: [] }>()

/** 21 years, as the law reads it: the birthday must have happened. */
const MIN_AGE = 21

const digits = ref('')

watch(
  () => props.open,
  (open) => {
    // Count-style input opens BLANK — never carrying the last customer's date forward.
    if (open) digits.value = ''
  },
)

/* ————— the cutoff ————— */

/**
 * Recomputed per open rather than once at module load: a register runs for days at a time
 * and a cutoff frozen at boot would quietly go stale over midnight.
 */
const today = ref(new Date())
watch(() => props.open, (open) => { if (open) today.value = new Date() })

const cutoff = computed(() => {
  const d = today.value
  return new Date(d.getFullYear() - MIN_AGE, d.getMonth(), d.getDate())
})

const longDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
/** Month and year only — naming the month a bad day was keyed into, not a date. */
const monthYear = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })
const cutoffLabel = computed(() => longDate.format(cutoff.value))

/* ————— parsing the eight digits ————— */

const mm = computed(() => digits.value.slice(0, 2))
const dd = computed(() => digits.value.slice(2, 4))
const yyyy = computed(() => digits.value.slice(4, 8))
const complete = computed(() => digits.value.length === 8)

/** Which box the next digit lands in — drives the caret ring. */
const caretIndex = computed(() => digits.value.length)

type Parsed =
  | { readonly ok: true, readonly date: Date, readonly age: number, readonly turns21: Date }
  | { readonly ok: false, readonly message: string }

/**
 * Whole years elapsed, counting the birthday itself as the day they turn — the same
 * comparison the cutoff expresses, done on calendar parts so no timezone or DST shift can
 * move somebody across a birthday.
 */
function yearsBetween(birth: Date, on: Date): number {
  let age = on.getFullYear() - birth.getFullYear()
  const monthDiff = on.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && on.getDate() < birth.getDate())) age -= 1
  return age
}

const parsed = computed<Parsed | null>(() => {
  if (!complete.value) return null

  const month = Number(mm.value)
  const day = Number(dd.value)
  const year = Number(yyyy.value)

  if (month < 1 || month > 12) return { ok: false, message: `There is no month ${month}.` }
  if (day < 1 || day > 31) return { ok: false, message: `There is no day ${day}.` }
  if (year < 1900) return { ok: false, message: 'That year looks like a typo.' }

  const date = new Date(year, month - 1, day)
  // Round-trip check: JS rolls 31 February forward to 3 March rather than refusing, so a
  // date that comes back different is a day that does not exist in that month.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { ok: false, message: `${monthYear.format(new Date(year, month - 1, 1))} has no day ${day}.` }
  }
  if (date > today.value) return { ok: false, message: 'That date is in the future.' }

  return {
    ok: true,
    date,
    age: yearsBetween(date, today.value),
    turns21: new Date(year + MIN_AGE, month - 1, day),
  }
})

const passes = computed(() => parsed.value?.ok === true && parsed.value.age >= MIN_AGE)
const canConfirm = computed(() => passes.value)

/* ————— input ————— */

function press(digit: string) {
  if (digits.value.length >= 8) return
  digits.value += digit
}
function backspace() {
  digits.value = digits.value.slice(0, -1)
}
function clear() {
  digits.value = ''
}

function submit() {
  const result = parsed.value
  if (!canConfirm.value || !result?.ok) return
  emit('confirm', result.age)
}

/**
 * A physical keyboard works everywhere the touch pad does — a keyboard-wedge scanner is a
 * keyboard, and the counter may have one attached. Deliberately NOT auto-submitting on the
 * eighth digit the way the PIN pad does: this one ends in an attestation, and a cashier
 * should have to look at the verdict before agreeing to it.
 */
function onKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (/^\d$/.test(event.key)) {
    event.preventDefault()
    press(event.key)
  } else if (event.key === 'Backspace') {
    event.preventDefault()
    backspace()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    submit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/** The mask, as eight boxes with their placeholder letters. */
const BOXES = ['M', 'M', 'D', 'D', 'Y', 'Y', 'Y', 'Y'] as const
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
</script>

<template>
  <!-- Teleported above z-50 for the same reason the step-up takeover is: an open shadcn
       Dialog overlay sits at body-end on z-50 and would otherwise eat every tap. -->
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 overflow-y-auto bg-background/[.985] p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Verify the customer's age"
    >
      <div class="flex w-full max-w-md items-center justify-between">
        <span class="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-500">
          21+ required
        </span>
        <button
          type="button"
          class="text-sm text-muted-foreground hover:text-foreground"
          @click="emit('close')"
        >
          ✕ Cancel
        </button>
      </div>

      <!-- the cutoff, first and largest: the one number that decides the sale -->
      <div class="text-center">
        <p class="text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground">
          Must be born on or before
        </p>
        <p class="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">{{ cutoffLabel }}</p>
        <p class="mt-1 text-xs text-muted-foreground">
          Read it off the licence, then key the date to record the check.
        </p>
      </div>

      <div class="h-px w-full max-w-md bg-border"></div>

      <!-- MM / DD / YYYY -->
      <div class="flex items-start gap-2">
        <template v-for="(letter, i) in BOXES" :key="i">
          <span v-if="i === 2 || i === 4" class="pt-3 text-xl text-muted-foreground">/</span>
          <span class="flex flex-col items-center">
            <span
              class="flex h-14 w-10 items-center justify-center rounded-lg border text-2xl font-bold tabular-nums transition-colors"
              :class="[
                digits[i] ? 'border-input bg-white/[.03]' : 'border-input bg-white/[.03] font-medium text-muted-foreground',
                caretIndex === i ? 'border-primary ring-[3px] ring-primary/25' : '',
              ]"
            >
              {{ digits[i] ?? letter }}
            </span>
            <span
              v-if="i === 0 || i === 2 || i === 4"
              class="mt-1.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground"
            >
              {{ i === 0 ? 'Month' : i === 2 ? 'Day' : 'Year' }}
            </span>
          </span>
        </template>
      </div>

      <!--
        The verdict sits under the mask and the PAD STAYS PUT beneath it, so correcting a
        mistyped digit is a backspace rather than a re-orientation.
      -->
      <div class="flex h-[74px] w-full max-w-md items-center justify-center">
        <div
          v-if="parsed && !parsed.ok"
          role="alert"
          class="w-full rounded-xl border border-destructive/45 bg-destructive/10 px-4 py-3 text-center"
        >
          <p class="text-sm font-bold text-destructive">{{ parsed.message }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">Check the date and key it again.</p>
        </div>

        <div
          v-else-if="parsed && parsed.ok && passes"
          role="status"
          class="w-full rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-center"
        >
          <p class="text-2xl font-extrabold tracking-tight text-primary">
            {{ parsed.age }} years old
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">Clear to sell</p>
        </div>

        <div
          v-else-if="parsed && parsed.ok"
          role="alert"
          class="w-full rounded-xl border border-destructive/45 bg-destructive/10 px-4 py-3 text-center"
        >
          <p class="text-2xl font-extrabold tracking-tight text-destructive">
            Under 21 — do not sell
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ parsed.age }} years old · turns 21 on {{ longDate.format(parsed.turns21) }}
          </p>
        </div>

        <p v-else class="text-xs text-muted-foreground">
          Key the date of birth — it is used to work out the age and is not stored.
        </p>
      </div>

      <!-- the pad -->
      <div class="grid w-full max-w-md grid-cols-3 gap-2.5">
        <button
          v-for="key in KEYS"
          :key="key"
          type="button"
          class="h-14 rounded-xl border bg-card text-xl font-semibold tabular-nums transition-colors hover:bg-accent active:bg-accent"
          @click="press(key)"
        >
          {{ key }}
        </button>
        <button
          type="button"
          class="h-14 rounded-xl text-sm font-medium text-muted-foreground transition-colors hover:bg-accent"
          @click="clear"
        >
          Clear
        </button>
        <button
          type="button"
          class="h-14 rounded-xl border bg-card text-xl font-semibold tabular-nums transition-colors hover:bg-accent active:bg-accent"
          @click="press('0')"
        >
          0
        </button>
        <button
          type="button"
          class="flex h-14 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent"
          aria-label="Delete the last digit"
          @click="backspace"
        >
          <Delete class="size-5" />
        </button>
      </div>

      <div class="grid w-full max-w-md grid-cols-2 gap-3">
        <Button variant="outline" class="h-12 text-base font-bold" @click="emit('close')">
          Cancel
        </Button>
        <Button class="h-12 text-base font-bold" :disabled="!canConfirm" @click="submit">
          Confirm
        </Button>
      </div>

      <p v-if="cashierName" class="text-xs text-muted-foreground">
        Recorded against this sale as checked by {{ cashierName }}.
      </p>
    </div>
  </Teleport>
</template>
