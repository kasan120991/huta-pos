<script setup lang="ts">
import { Button } from '~/components/ui/button'
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

/** Full-screen page — the back-office shell doesn't apply to the front door. */
definePageMeta({ layout: false })

const auth = useAuthStore()
const route = useRoute()

const email = ref('')
const password = ref('')
const pending = ref(false)
const errorMessage = ref<string | null>(null)

// Session resolution, the signed-in redirect, and the CSRF cookie plant all happen in
// middleware/auth.global.ts before this page renders.

/**
 * Arriving because a session ran out, rather than by choice.
 *
 * `useApi` sends an admin here when a refresh genuinely fails, so the page has to say why —
 * landing on a login form with no explanation is the confusing half of the old behaviour.
 */
const expired = computed(() => route.query['expired'] === '1')

/**
 * Where to go back to after signing in.
 *
 * Only a same-origin PATH is honoured. A bare `startsWith('/')` is not enough: `//evil.test`
 * also starts with a slash and a browser reads it as protocol-relative, which is an open
 * redirect handed straight to whoever wrote the link.
 */
const next = computed(() => {
  const raw = route.query['next']
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
})

async function submit() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = null
  try {
    await auth.login({ email: email.value, password: password.value })
    await navigateTo(next.value, { replace: true })
  } catch (error) {
    errorMessage.value =
      error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="grid min-h-svh bg-background text-foreground lg:grid-cols-2">
    <!-- Left half: wordmark + form -->
    <div class="flex flex-col py-8">
      <div class="flex items-center gap-2 px-10 font-semibold tracking-tight">
        <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11Z" stroke="currentColor" stroke-width="1.6" />
          <path d="M12 8v11" stroke="currentColor" stroke-width="1.6" />
        </svg>
        Huta
      </div>

      <div class="flex flex-1 items-center justify-center px-6">
        <div class="flex w-full max-w-xs flex-col gap-6">
          <div>
            <h1 class="text-xl font-semibold tracking-tight">Sign in</h1>
            <p class="mt-1 text-sm text-muted-foreground">Back-office access for admins</p>
          </div>

          <form novalidate @submit.prevent="submit">
            <FieldGroup>
              <Field>
                <FieldLabel for="email">Email</FieldLabel>
                <Input
                  id="email"
                  v-model="email"
                  type="email"
                  autocomplete="email"
                  required
                  autofocus
                />
              </Field>
              <Field>
                <FieldLabel for="password">Password</FieldLabel>
                <Input
                  id="password"
                  v-model="password"
                  type="password"
                  autocomplete="current-password"
                  required
                />
              </Field>
              <FieldDescription v-if="expired && !errorMessage">
                Your session timed out. Sign in and we'll take you back to where you were.
              </FieldDescription>
              <FieldError v-if="errorMessage">{{ errorMessage }}</FieldError>
              <Field>
                <Button type="submit" :disabled="pending">
                  {{ pending ? 'Signing in…' : 'Sign in' }}
                </Button>
              </Field>
            </FieldGroup>
          </form>

          <p class="text-xs text-muted-foreground">
            Setting up a register? Pair it at
            <code class="font-mono">/register/pair</code>
          </p>
        </div>
      </div>
    </div>

    <!-- Right half: the brand panel. Decorative, so hidden from small screens and readers. -->
    <div
      class="relative hidden flex-col justify-end overflow-hidden border-l bg-card p-10 lg:flex"
      aria-hidden="true"
    >
      <svg
        class="absolute -right-36 -top-28 size-[38rem] text-primary/25"
        viewBox="-100 -100 200 200"
        fill="none"
      >
        <g stroke="currentColor" stroke-width="1">
          <path transform="rotate(0)" d="M0 0 C 7 -22 7 -52 0 -72 C -7 -52 -7 -22 0 0 Z" />
          <path transform="rotate(38)" d="M0 0 C 6 -19 6 -44 0 -60 C -6 -44 -6 -19 0 0 Z" />
          <path transform="rotate(-38)" d="M0 0 C 6 -19 6 -44 0 -60 C -6 -44 -6 -19 0 0 Z" />
          <path transform="rotate(74)" d="M0 0 C 5 -15 5 -34 0 -46 C -5 -34 -5 -15 0 0 Z" />
          <path transform="rotate(-74)" d="M0 0 C 5 -15 5 -34 0 -46 C -5 -34 -5 -15 0 0 Z" />
          <path transform="rotate(105)" d="M0 0 C 4 -10 4 -22 0 -30 C -4 -22 -4 -10 0 0 Z" />
          <path transform="rotate(-105)" d="M0 0 C 4 -10 4 -22 0 -30 C -4 -22 -4 -10 0 0 Z" />
          <path d="M0 0 L0 26" />
        </g>
      </svg>
      <div class="text-3xl font-bold tracking-tight">Huta</div>
      <p class="mt-1 text-sm text-muted-foreground">Point of sale</p>
    </div>
  </main>
</template>
