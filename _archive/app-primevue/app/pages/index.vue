<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <section class="landing">
    <h1>Signed in</h1>
    <p class="lede">
      The session is live and the API is answering through the proxy. Catalog, inventory and
      the register land in later phases.
    </p>

    <dl class="facts">
      <div>
        <dt>Signed in as</dt>
        <!-- A name, now that /auth/me returns one. This printed a raw cuid until then. -->
        <dd>{{ auth.displayName ?? '—' }}</dd>
      </div>
      <div v-if="auth.user?.email">
        <dt>Email</dt>
        <dd>{{ auth.user.email }}</dd>
      </div>
      <div>
        <dt>Role</dt>
        <dd>{{ auth.principal?.role ?? '—' }}</dd>
      </div>
      <div>
        <dt>Store scope</dt>
        <dd>{{ auth.principal?.storeId ?? 'All stores' }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.landing {
  max-width: 60ch;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.lede {
  color: var(--p-text-muted-color);
}

.facts {
  margin: 2rem 0 0;
  display: grid;
  gap: 0.75rem;
}

.facts > div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}

dt {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
}
</style>
