<script setup lang="ts">
import { formatCents, unsafe } from '@huta/shared'
import type { SupplierRow } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * Supplier records — master-detail, the same shape as /admin/pricing.
 *
 * Everything on the right is admin-only in practice: this page lives in the back office,
 * which a terminal session cannot reach. The server still strips commercial terms by
 * capability rather than trusting that, so a staff principal reading the same endpoint gets
 * contact details and nothing else.
 */

const suppliers = ref<SupplierRow[]>([])
const selectedId = ref<string | null>(null)
const showInactive = ref(false)
const search = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const savedAt = ref<number | null>(null)
const creating = ref(false)

async function load(keepSelection = true): Promise<void> {
  const data = await apiFetch<{ suppliers: SupplierRow[] }>('/suppliers', {
    query: {
      ...(showInactive.value ? { includeInactive: 'true' } : {}),
      ...(search.value.trim() ? { search: search.value.trim() } : {}),
    },
  })
  suppliers.value = data.suppliers
  if (!keepSelection || !suppliers.value.some((s) => s.id === selectedId.value)) {
    selectedId.value = suppliers.value[0]?.id ?? null
  }
}

await load(false)

const selected = computed(() => suppliers.value.find((s) => s.id === selectedId.value) ?? null)

// --- the draft, mirrored from the selected supplier --------------------------------------

interface Draft {
  name: string
  contactName: string
  phone: string
  email: string
  website: string
  addressLine1: string
  city: string
  state: string
  postalCode: string
  accountNumber: string
  paymentTerms: string
  minimumOrderDollars: string
  licenseNumber: string
  notes: string
  active: boolean
}

function emptyDraft(): Draft {
  return {
    name: '',
    contactName: '',
    phone: '',
    email: '',
    website: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    accountNumber: '',
    paymentTerms: '',
    minimumOrderDollars: '',
    licenseNumber: '',
    notes: '',
    active: true,
  }
}

const draft = ref<Draft>(emptyDraft())

function syncDraft(): void {
  const s = selected.value
  if (!s || creating.value) return
  draft.value = {
    name: s.name,
    contactName: s.contactName ?? '',
    phone: s.phone ?? '',
    email: s.email ?? '',
    website: s.website ?? '',
    addressLine1: s.addressLine1 ?? '',
    city: s.city ?? '',
    state: s.state ?? '',
    postalCode: s.postalCode ?? '',
    accountNumber: s.accountNumber ?? '',
    paymentTerms: s.paymentTerms ?? '',
    minimumOrderDollars:
      s.minimumOrderCents === null || s.minimumOrderCents === undefined
        ? ''
        : (s.minimumOrderCents / 100).toFixed(2),
    licenseNumber: s.licenseNumber ?? '',
    notes: s.notes ?? '',
    active: s.active,
  }
}

watch(selectedId, syncDraft, { immediate: true })
watch(suppliers, syncDraft)

/** Dollars typed as a string, parsed by the digits — never `parseFloat * 100`. */
function dollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

const minimumOrderValid = computed(
  () => draft.value.minimumOrderDollars.trim() === '' || dollarsToCents(draft.value.minimumOrderDollars) !== null,
)

function select(id: string): void {
  creating.value = false
  selectedId.value = id
}

function startNew(): void {
  creating.value = true
  selectedId.value = null
  draft.value = emptyDraft()
  error.value = null
}

function cancelNew(): void {
  creating.value = false
  selectedId.value = suppliers.value[0]?.id ?? null
  syncDraft()
}

function body() {
  const d = draft.value
  return {
    name: d.name.trim(),
    contactName: d.contactName,
    phone: d.phone,
    email: d.email,
    website: d.website,
    addressLine1: d.addressLine1,
    city: d.city,
    state: d.state,
    postalCode: d.postalCode,
    accountNumber: d.accountNumber,
    paymentTerms: d.paymentTerms,
    minimumOrderCents: dollarsToCents(d.minimumOrderDollars),
    licenseNumber: d.licenseNumber,
    notes: d.notes,
    active: d.active,
  }
}

async function save(): Promise<void> {
  if (draft.value.name.trim() === '') {
    error.value = 'A supplier needs a name.'
    return
  }
  if (!minimumOrderValid.value) {
    error.value = 'Minimum order should be a dollar amount, like 500.00.'
    return
  }

  saving.value = true
  error.value = null
  try {
    if (creating.value) {
      const created = await apiFetch<SupplierRow>('/suppliers', { method: 'POST', body: body() })
      creating.value = false
      await load(false)
      selectedId.value = created.id
    } else {
      const current = selected.value
      if (!current) return
      await apiFetch(`/suppliers/${current.id}`, { method: 'PATCH', body: body() })
      await load()
    }
    savedAt.value = Date.now()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save that supplier.'
  } finally {
    saving.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch([search, showInactive], () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), 200)
})

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return formatCents(unsafe.cents(cents))
}
</script>

<template>
  <section class="suppliers">
    <header class="head">
      <h1>Suppliers</h1>
      <span class="count">
        {{ suppliers.length }} {{ suppliers.length === 1 ? 'supplier' : 'suppliers' }}
      </span>
    </header>

    <div class="body">
      <!-- master -->
      <aside class="list">
        <div class="tools">
          <InputText v-model="search" class="find" placeholder="Find a supplier" />
          <button
            type="button"
            class="chip"
            :class="{ on: showInactive }"
            :aria-pressed="showInactive"
            @click="showInactive = !showInactive"
          >
            Show inactive
          </button>
        </div>

        <ul class="rows">
          <li v-for="s in suppliers" :key="s.id">
            <button
              type="button"
              class="row"
              :class="{ on: s.id === selectedId, off: !s.active }"
              @click="select(s.id)"
            >
              <span class="nm">{{ s.name }}</span>
              <span class="sub">
                {{ s.contactName ?? 'No contact' }}
                <template v-if="!s.active"> · inactive</template>
              </span>
              <span class="pc">{{ s.productCount }}</span>
            </button>
          </li>
          <li v-if="suppliers.length === 0" class="empty">Nothing matches that.</li>
        </ul>

        <Button
          label="New supplier"
          severity="secondary"
          size="small"
          class="new"
          @click="startNew"
        />
      </aside>

      <!-- detail -->
      <div v-if="selected || creating" class="editor">
        <div class="ename">
          <span class="n">{{ creating ? 'New supplier' : selected?.name }}</span>
          <span v-if="!creating && selected" class="badge">
            {{ selected.productCount }}
            {{ selected.productCount === 1 ? 'product' : 'products' }}
          </span>
          <span v-if="!creating && selected && !selected.active" class="badge off">Inactive</span>
        </div>

        <div class="grid">
          <div class="field">
            <label for="s-name">Name</label>
            <InputText id="s-name" v-model="draft.name" />
          </div>
          <div class="field">
            <label for="s-contact">Contact</label>
            <InputText id="s-contact" v-model="draft.contactName" />
          </div>
          <div class="field">
            <label for="s-phone">Phone</label>
            <InputText id="s-phone" v-model="draft.phone" inputmode="tel" />
          </div>
          <div class="field">
            <label for="s-email">Email</label>
            <InputText id="s-email" v-model="draft.email" inputmode="email" />
          </div>
          <div class="field wide">
            <label for="s-web">Website</label>
            <InputText id="s-web" v-model="draft.website" />
          </div>
          <div class="field wide">
            <label for="s-addr">Address</label>
            <InputText id="s-addr" v-model="draft.addressLine1" />
          </div>
          <div class="field">
            <label for="s-city">City</label>
            <InputText id="s-city" v-model="draft.city" />
          </div>
          <div class="field two">
            <div>
              <label for="s-state">State</label>
              <InputText id="s-state" v-model="draft.state" />
            </div>
            <div>
              <label for="s-zip">ZIP</label>
              <InputText id="s-zip" v-model="draft.postalCode" />
            </div>
          </div>
        </div>

        <!--
          Terms are the fields staff never receive. They are grouped and labelled so it is
          obvious which half of this record is confidential.
        -->
        <div class="terms">
          <div class="tlabel">Commercial terms — not shown to staff</div>
          <div class="grid">
            <div class="field">
              <label for="s-acct">Account number</label>
              <InputText id="s-acct" v-model="draft.accountNumber" />
            </div>
            <div class="field">
              <label for="s-terms">Payment terms</label>
              <InputText id="s-terms" v-model="draft.paymentTerms" placeholder="Net 30" />
            </div>
            <div class="field">
              <label for="s-min">Minimum order</label>
              <span class="money">
                <span class="sym">$</span>
                <InputText
                  id="s-min"
                  v-model="draft.minimumOrderDollars"
                  class="amt"
                  inputmode="decimal"
                  :class="{ bad: !minimumOrderValid }"
                />
              </span>
            </div>
            <div class="field">
              <label for="s-lic">License number</label>
              <InputText id="s-lic" v-model="draft.licenseNumber" />
            </div>
          </div>
          <div class="field">
            <label for="s-notes">Internal notes</label>
            <Textarea id="s-notes" v-model="draft.notes" rows="3" auto-resize />
          </div>
        </div>

        <div class="foot">
          <button
            type="button"
            class="chip"
            :class="{ on: draft.active }"
            :aria-pressed="draft.active"
            @click="draft.active = !draft.active"
          >
            {{ draft.active ? 'Active' : 'Inactive' }}
          </button>
          <!--
            No delete. Purchase orders, receipts, batches and sale lines all reference a
            supplier; deactivating keeps every one of those answerable.
          -->
          <span class="hint">Suppliers are deactivated, never deleted — history references them.</span>

          <span class="spacer" />
          <Button
            v-if="creating"
            label="Cancel"
            severity="secondary"
            variant="text"
            size="small"
            @click="cancelNew"
          />
          <Button
            :label="creating ? 'Create supplier' : 'Save changes'"
            size="small"
            :loading="saving"
            @click="save"
          />
        </div>

        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <p v-else-if="savedAt" class="ok">Saved.</p>

        <div v-if="!creating && selected" class="meta">
          <span>Minimum order {{ money(selected.minimumOrderCents) }}</span>
          <span v-if="selected.paymentTerms">· {{ selected.paymentTerms }}</span>
        </div>
      </div>

      <p v-else class="state">No suppliers yet.</p>
    </div>
  </section>
</template>

<style scoped>
.suppliers {
  display: grid;
  gap: 1rem;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 1rem;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: -0.015em;
}

.count {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.body {
  display: grid;
  grid-template-columns: 17rem minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@container content (max-width: 1000px) {
  .body {
    grid-template-columns: 1fr;
  }
}

.list {
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.tools {
  display: grid;
  gap: 0.4rem;
}

.find {
  width: 100%;
  font-size: 0.875rem;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.15rem;
  max-height: 28rem;
  overflow-y: auto;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 0.5rem;
  text-align: left;
  padding: 0.4rem 0.5rem;
  font: inherit;
  color: var(--p-text-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  cursor: pointer;
}

.row:hover {
  background: var(--p-surface-50);
}

.app-dark .row:hover {
  background: var(--p-surface-800);
}

.row.on {
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  border-color: var(--p-primary-color);
}

.row.off .nm {
  color: var(--p-text-muted-color);
}

.row:focus-visible,
.chip:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.nm {
  font-size: 0.875rem;
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  grid-column: 1;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pc {
  /* Both explicit: with only grid-row set, auto-placement claimed column 1 and pushed the
     name into column 2, rendering the count to the LEFT of the supplier it counts. */
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
}

.empty {
  padding: 0.6rem 0.5rem;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.new {
  justify-self: start;
}

.editor {
  display: grid;
  gap: 1.1rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}

.ename {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.ename .n {
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.badge {
  font-size: 0.6875rem;
  font-weight: 620;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
}

.badge.off {
  background: color-mix(in srgb, var(--p-text-muted-color) 16%, transparent);
  color: var(--p-text-muted-color);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
}

.field {
  display: grid;
  gap: 0.3rem;
  align-content: start;
}

.field.wide {
  grid-column: 1 / -1;
}

.field.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.field.two > div {
  display: grid;
  gap: 0.3rem;
}

label {
  font-size: 0.625rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.terms {
  display: grid;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px dashed var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-surface-50);
}

.app-dark .terms {
  background: var(--p-surface-900);
}

.tlabel {
  font-size: 0.6875rem;
  font-weight: 650;
  color: var(--p-text-muted-color);
}

.money {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

.sym {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}

.amt {
  width: 7rem;
  font-variant-numeric: tabular-nums;
}

.amt.bad {
  border-color: var(--p-red-600);
}

.foot {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.chip {
  padding: 0.25rem 0.6rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.375rem;
  cursor: pointer;
}

.chip.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 620;
}

.hint,
.meta {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.meta {
  display: flex;
  gap: 0.35rem;
}

.ok {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-primary-color);
}

.state {
  color: var(--p-text-muted-color);
}
</style>
