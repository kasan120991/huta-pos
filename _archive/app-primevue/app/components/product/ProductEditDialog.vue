<script setup lang="ts">
import { STRAIN_TYPE_VALUES } from '@huta/shared'
import type { CatalogProductDetail } from '@huta/shared/schemas'
import { computed, ref, watch } from 'vue'

import { ApiError, apiFetch } from '~/composables/useApi'
import { useCatalogStore } from '~/stores/catalog'

/**
 * The product editor — every product-level fact in one dialog.
 *
 * The draft is seeded from the payload and diffed on save, so the PATCH carries only what
 * changed — the audit trail then records exactly the fields that moved, nothing else.
 */
const props = defineProps<{ product: CatalogProductDetail }>()

const emit = defineEmits<{ close: []; saved: [] }>()

const catalog = useCatalogStore()

const draft = ref({
  name: props.product.name,
  description: props.product.description ?? '',
  categoryId: props.product.category.id,
  brandId: props.product.brand?.id ?? null,
  primarySupplierId: props.product.primarySupplier?.id ?? null,
  coaUrl: props.product.coaUrl ?? '',
  strainType: props.product.strainType ?? null,
  terpeneProfile: props.product.terpeneProfile ?? '',
  nose: props.product.nose ?? '',
  active: props.product.active,
})

const saving = ref(false)
const error = ref<string | null>(null)

watch(draft, () => (error.value = null), { deep: true })

/** Flattened category tree — children indented under their parent, both selectable. */
const categoryOptions = computed(() => {
  const options: Array<{ label: string; value: string }> = []
  for (const parent of catalog.categoryTree) {
    options.push({ label: parent.name, value: parent.id })
    for (const child of parent.children) {
      options.push({ label: `${parent.name} › ${child.name}`, value: child.id })
    }
  }
  return options
})

const brandOptions = computed(() => [
  { label: 'No brand', value: null as string | null },
  ...(catalog.reference?.brands ?? []).map((b) => ({ label: b.name, value: b.id as string | null })),
])

const supplierOptions = ref<Array<{ label: string; value: string | null }>>([
  { label: 'No supplier', value: null },
])

// Suppliers aren't in the catalog reference — one fetch when the dialog opens.
void apiFetch<{ suppliers: Array<{ id: string; name: string }> }>('/suppliers')
  .then((data) => {
    supplierOptions.value = [
      { label: 'No supplier', value: null },
      ...data.suppliers.map((s) => ({ label: s.name, value: s.id as string | null })),
    ]
  })
  .catch(() => {})

const strainOptions = [
  { label: 'Not a strain', value: null as string | null },
  ...STRAIN_TYPE_VALUES.map((v) => ({
    label: v.charAt(0) + v.slice(1).toLowerCase(),
    value: v as string | null,
  })),
]

// --- inline brand create -------------------------------------------------------------------

const creatingBrand = ref(false)
const newBrandName = ref('')

async function addBrand(): Promise<void> {
  const name = newBrandName.value.trim()
  if (!name) return
  try {
    const brand = await catalog.createBrand(name)
    draft.value.brandId = brand.id
    creatingBrand.value = false
    newBrandName.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not create that brand.'
  }
}

// --- save ----------------------------------------------------------------------------------

const canSave = computed(() => draft.value.name.trim().length > 0 && !saving.value)

function buildPatch(): Record<string, unknown> {
  const d = draft.value
  const p = props.product
  const patch: Record<string, unknown> = {}
  if (d.name.trim() !== p.name) patch['name'] = d.name.trim()
  if ((d.description.trim() || null) !== p.description) {
    patch['description'] = d.description.trim() || null
  }
  if (d.categoryId !== p.category.id) patch['categoryId'] = d.categoryId
  if (d.brandId !== (p.brand?.id ?? null)) patch['brandId'] = d.brandId
  if (d.primarySupplierId !== (p.primarySupplier?.id ?? null)) {
    patch['primarySupplierId'] = d.primarySupplierId
  }
  if ((d.coaUrl.trim() || null) !== p.coaUrl) patch['coaUrl'] = d.coaUrl.trim()
  if (d.strainType !== p.strainType) patch['strainType'] = d.strainType
  if ((d.terpeneProfile.trim() || null) !== p.terpeneProfile) {
    patch['terpeneProfile'] = d.terpeneProfile.trim() || null
  }
  if ((d.nose.trim() || null) !== p.nose) patch['nose'] = d.nose.trim() || null
  if (d.active !== p.active) patch['active'] = d.active
  return patch
}

async function save(): Promise<void> {
  if (!canSave.value) return
  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    emit('close')
    return
  }
  saving.value = true
  try {
    await catalog.updateProduct(props.product.id, patch)
    emit('saved')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not save the product.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    :draggable="false"
    :style="{ width: 'min(34rem, calc(100vw - 3rem))' }"
    @update:visible="emit('close')"
  >
    <template #header>
      <div class="dhead">
        <h2>Edit product</h2>
        <p class="who">{{ product.name }}</p>
      </div>
    </template>

    <div class="body">
      <div class="grid">
        <div class="field wide">
          <label for="pe-name">Name</label>
          <InputText id="pe-name" v-model="draft.name" autocomplete="off" />
        </div>

        <div class="field">
          <label for="pe-category">Category</label>
          <Select
            id="pe-category"
            v-model="draft.categoryId"
            :options="categoryOptions"
            option-label="label"
            option-value="value"
            filter
            size="small"
          />
        </div>

        <div class="field">
          <label for="pe-brand">Brand</label>
          <Select
            id="pe-brand"
            v-model="draft.brandId"
            :options="brandOptions"
            option-label="label"
            option-value="value"
            filter
            size="small"
          />
          <button v-if="!creatingBrand" type="button" class="mini" @click="creatingBrand = true">
            New brand…
          </button>
          <div v-else class="newbrand">
            <InputText
              v-model="newBrandName"
              placeholder="Brand name"
              size="small"
              autocomplete="off"
              @keydown.enter.prevent="addBrand"
            />
            <Button label="Add" size="small" :disabled="!newBrandName.trim()" @click="addBrand" />
          </div>
        </div>

        <div class="field">
          <label for="pe-supplier">Supplier</label>
          <Select
            id="pe-supplier"
            v-model="draft.primarySupplierId"
            :options="supplierOptions"
            option-label="label"
            option-value="value"
            filter
            size="small"
          />
          <small class="hint">
            Changes future attribution only — past sales keep the supplier they had.
          </small>
        </div>

        <div class="field">
          <label for="pe-strain">Strain type</label>
          <Select
            id="pe-strain"
            v-model="draft.strainType"
            :options="strainOptions"
            option-label="label"
            option-value="value"
            size="small"
          />
        </div>

        <div class="field wide">
          <label for="pe-coa">COA URL</label>
          <InputText id="pe-coa" v-model="draft.coaUrl" placeholder="https://…" autocomplete="off" />
        </div>

        <div class="field">
          <label for="pe-terpenes">Terpenes</label>
          <InputText id="pe-terpenes" v-model="draft.terpeneProfile" autocomplete="off" />
        </div>

        <div class="field">
          <label for="pe-nose">Nose</label>
          <InputText id="pe-nose" v-model="draft.nose" autocomplete="off" />
        </div>

        <div class="field wide">
          <label for="pe-desc">Description</label>
          <Textarea id="pe-desc" v-model="draft.description" rows="3" auto-resize />
        </div>

        <div class="field wide onoff">
          <ToggleSwitch v-model="draft.active" input-id="pe-active" />
          <label for="pe-active" class="plain">
            Active
            <span class="hint">— an inactive product leaves the register and the catalog list.</span>
          </label>
        </div>
      </div>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" variant="text" @click="emit('close')" />
      <Button label="Save" :disabled="!canSave" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.dhead {
  display: grid;
  gap: 0.2rem;
}

h2 {
  margin: 0;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
}

.who {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.body {
  display: grid;
  gap: 1rem;
  padding-top: 0.25rem;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.field {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}

.field.wide {
  grid-column: 1 / -1;
}

label {
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

label.plain {
  text-transform: none;
  letter-spacing: normal;
  font-size: 0.8125rem;
  color: var(--p-text-color);
}

.hint {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
  letter-spacing: normal;
  text-transform: none;
}

.onoff {
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0.6rem;
}

.mini {
  justify-self: start;
  padding: 0;
  font: inherit;
  font-size: 0.72rem;
  color: var(--p-primary-color);
  background: none;
  border: 0;
  cursor: pointer;
}

.mini:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.newbrand {
  display: flex;
  gap: 0.4rem;
}
</style>
