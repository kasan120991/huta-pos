<script setup lang="ts">
import { loginRequestSchema } from '@huta/shared/schemas'
import { computed, ref } from 'vue'

import { ApiError } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'

definePageMeta({ layout: 'bare' })

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const formError = ref<string | null>(null)
const lockedSeconds = ref<number | null>(null)
const fieldErrors = ref<Record<string, string>>({})

const lockoutMessage = computed(() => {
  if (lockedSeconds.value === null) return null
  const minutes = Math.ceil(lockedSeconds.value / 60)
  return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
})

async function submit(): Promise<void> {
  formError.value = null
  lockedSeconds.value = null
  fieldErrors.value = {}

  // Validate against the SAME schema the server uses, so the two can never disagree
  // about what a valid email is.
  const parsed = loginRequestSchema.safeParse({ email: email.value, password: password.value })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.')
      if (!fieldErrors.value[key]) fieldErrors.value[key] = issue.message
    }
    return
  }

  submitting.value = true
  try {
    await auth.login(parsed.data)
    await router.push('/')
  } catch (error) {
    if (!(error instanceof ApiError)) {
      formError.value = 'Something went wrong. Please try again.'
      return
    }

    if (error.code === 'ACCOUNT_LOCKED') {
      lockedSeconds.value = error.retryAfterSeconds ?? 900
    } else if (error.code === 'VALIDATION_FAILED') {
      // `path` arrives as a dot-joined string, not an array.
      for (const issue of error.issues) {
        if (issue.path) fieldErrors.value[issue.path] = issue.message
        else formError.value = issue.message
      }
    } else {
      // Includes the 401. The server returns one generic message for both a wrong
      // password and an unknown email — surface it as-is rather than trying to be more
      // helpful, because "no account with that email" confirms which addresses exist.
      formError.value = error.message
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login">
    <!-- Left: brand panel. Botanical forms bleed off the edges at low contrast — drawn
         in code, so there is no asset to host and nothing to go stale. -->
    <aside class="panel">
      <svg
        class="botanical"
        viewBox="0 0 400 460"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <g fill="currentColor">
          <path d="M330 470c0-150 60-260 175-310-25 190-95 260-175 310Z" />
          <path d="M330 470c-80-50-150-120-175-310 115 50 175 160 175 310Z" opacity=".65" />
          <path d="M60 300c0-95 38-165 111-197-16 121-60 165-111 197Z" opacity=".5" />
          <path d="M60 300c-51-32-95-76-111-197 73 32 111 102 111 197Z" opacity=".35" />
          <path d="M250 120c0-58 23-100 67-120-9 73-36 100-67 120Z" opacity=".3" />
        </g>
      </svg>

      <HutaMark class="panel-mark" />
      <p class="statement">Point of sale built for cannabinoid retail.</p>
    </aside>

    <!-- Right: the form. -->
    <main class="form-side">
      <form class="form" novalidate @submit.prevent="submit">
        <div class="heading">
          <h1>Sign in</h1>
          <p class="sub">Back office access</p>
        </div>

        <Message v-if="lockoutMessage" severity="warn" :closable="false">
          {{ lockoutMessage }}
        </Message>
        <Message v-else-if="formError" severity="error" :closable="false">
          {{ formError }}
        </Message>

        <div class="field">
          <label for="email">Email</label>
          <InputText
            id="email"
            v-model="email"
            type="email"
            autocomplete="username"
            :invalid="Boolean(fieldErrors.email)"
            :disabled="submitting"
            placeholder="you@huta.local"
            fluid
          />
          <small v-if="fieldErrors.email" class="field-error">{{ fieldErrors.email }}</small>
        </div>

        <div class="field">
          <label for="password">Password</label>
          <!-- autocomplete goes through input-props: Password renders a wrapper, so a
               bare attribute lands on the span rather than the input the browser reads. -->
          <Password
            id="password"
            v-model="password"
            :input-props="{ autocomplete: 'current-password' }"
            :invalid="Boolean(fieldErrors.password)"
            :disabled="submitting"
            :feedback="false"
            toggle-mask
            fluid
          />
          <small v-if="fieldErrors.password" class="field-error">
            {{ fieldErrors.password }}
          </small>
        </div>

        <Button type="submit" label="Sign in" :loading="submitting" fluid />
      </form>
    </main>
  </div>
</template>

<style scoped>
.login {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 5fr 6fr;
}

/* The panel is the majority of the screen; below this width it stops earning its half
   and the form gets the whole viewport instead. */
@media (max-width: 820px) {
  .login {
    grid-template-columns: 1fr;
  }

  .panel {
    display: none;
  }
}

.panel {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 2rem;
  padding: clamp(1.75rem, 1rem + 2vw, 3rem);
  background: var(--p-primary-800);
  color: var(--p-primary-50);
}

.app-dark .panel {
  background: var(--p-primary-900);
}

.botanical {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  color: currentColor;
  /* Low enough that the wordmark never has to fight it. */
  opacity: 0.13;
  pointer-events: none;
}

.panel-mark,
.statement {
  position: relative;
  z-index: 1;
}

.statement {
  margin: 0;
  font-size: clamp(1.25rem, 1rem + 1vw, 1.75rem);
  line-height: 1.25;
  letter-spacing: -0.015em;
  max-width: 18ch;
  text-wrap: balance;
}

.form-side {
  display: grid;
  align-content: center;
  padding: clamp(2rem, 1rem + 4vw, 4rem);
  background: var(--p-surface-0);
}

.app-dark .form-side {
  background: var(--p-surface-900);
}

.form {
  width: min(360px, 100%);
  margin: 0 auto;
  display: grid;
  gap: 1.125rem;
}

.heading h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.heading .sub {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

.field {
  display: grid;
  gap: 0.375rem;
}

.field label {
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.field-error {
  color: var(--p-red-600);
  font-size: 0.8125rem;
}

.app-dark .field-error {
  color: var(--p-red-400);
}
</style>
