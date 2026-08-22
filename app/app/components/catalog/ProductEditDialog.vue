<script setup lang="ts">
import type { CatalogProductDetail, CatalogReference, ProductPatchInput } from '@huta/shared/schemas'
import { FLOWER_CATEGORY_SLUG, STRAIN_TYPE_VALUES } from '@huta/shared'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '~/components/ui/field'
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
 * The product identity editor — everything on the Product row except `active` (the
 * hero's Deactivate/Reactivate owns that).
 *
 * Saves a DIRTY DIFF: only keys whose value actually changed are sent, which is exactly
 * what the server's audit row records. An untouched form saves nothing and just closes.
 * Renaming regenerates the slug server-side (idempotently — re-saving the same name
 * never grows a `-2`).
 */
const props = defineProps<{
  open: boolean
  product: CatalogProductDetail
  reference: CatalogReference
}>()
const emit = defineEmits<{ close: [], saved: [] }>()

/** Select components can't unset via an empty value — a sentinel stands in for null. */
const NONE = '__none__'

const name = ref('')
const description = ref('')
const categoryId = ref('')
const brandId = ref(NONE)
const supplierId = ref(NONE)
const coaUrl = ref('')
const strainType = ref(NONE)
const terpeneProfile = ref('')
const nose = ref('')
const newBrandMode = ref(false)
const newBrandName = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

/** Suppliers aren't in the reference — one fetch per dialog open, degrading silently. */
const suppliers = ref<Array<{ id: string, name: string }>>([])

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const p = props.product
    name.value = p.name
    description.value = p.description ?? ''
    categoryId.value = p.category.id
    brandId.value = p.brand?.id ?? NONE
    supplierId.value = p.primarySupplier?.id ?? NONE
    coaUrl.value = p.coaUrl ?? ''
    strainType.value = p.strainType ?? NONE
    terpeneProfile.value = p.terpeneProfile ?? ''
    nose.value = p.nose ?? ''
    newBrandMode.value = false
    newBrandName.value = ''
    error.value = null
    apiFetch<{ suppliers: Array<{ id: string, name: string }> }>('/suppliers')
      .then((data) => (suppliers.value = data.suppliers))
      .catch(() => (suppliers.value = []))
  },
)

// An error describes the save as it was attempted — editing anything retires it.
watch([name, description, categoryId, brandId, supplierId, coaUrl, strainType, terpeneProfile, nose], () => {
  error.value = null
})

/** Leaf categories only — products file on leaves. Labeled with their parent for context. */
const leafCategories = computed(() => {
  const cats = props.reference.categories
  const hasChildren = new Set(cats.filter((c) => c.parentId !== null).map((c) => c.parentId))
  const byId = new Map(cats.map((c) => [c.id, c]))
  return cats
    .filter((c) => !hasChildren.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.parentId ? `${byId.get(c.parentId)?.name} › ${c.name}` : c.name,
    }))
})

/** Is the CHOSEN category inside the Flower subtree? Drives the strain block. */
const isFlower = computed(() => {
  const byId = new Map(props.reference.categories.map((c) => [c.id, c]))
  let current = byId.get(categoryId.value)
  while (current) {
    if (current.slug === FLOWER_CATEGORY_SLUG) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
})

/** Brands created inside this dialog session, merged ahead of the reference list. */
const createdBrands = ref<Array<{ id: string, name: string }>>([])
const brandOptions = computed(() => [...createdBrands.value, ...props.reference.brands])

async function saveNewBrand() {
  const brandName = newBrandName.value.trim()
  if (!brandName) return
  try {
    const brand = await apiFetch<{ id: string, name: string }>('/catalog/brands', {
      method: 'POST',
      body: { name: brandName },
    })
    createdBrands.value.push(brand)
    brandId.value = brand.id
    newBrandMode.value = false
    newBrandName.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Could not create the brand.'
  }
}

const trimOrNull = (value: string) => value.trim() || null
const fromSentinel = (value: string) => (value === NONE ? null : value)

/** Only the keys that actually changed — the audit row records exactly these. */
function buildPatch(): ProductPatchInput {
  const p = props.product
  const patch: Record<string, unknown> = {}
  if (name.value.trim() && name.value.trim() !== p.name) patch['name'] = name.value.trim()
  if (trimOrNull(description.value) !== (p.description ?? null)) patch['description'] = trimOrNull(description.value)
  if (categoryId.value && categoryId.value !== p.category.id) patch['categoryId'] = categoryId.value
  if (fromSentinel(brandId.value) !== (p.brand?.id ?? null)) patch['brandId'] = fromSentinel(brandId.value)
  if (fromSentinel(supplierId.value) !== (p.primarySupplier?.id ?? null)) patch['primarySupplierId'] = fromSentinel(supplierId.value)
  if (trimOrNull(coaUrl.value) !== (p.coaUrl ?? null)) patch['coaUrl'] = trimOrNull(coaUrl.value)
  if (fromSentinel(strainType.value) !== (p.strainType ?? null)) patch['strainType'] = fromSentinel(strainType.value)
  if (trimOrNull(terpeneProfile.value) !== (p.terpeneProfile ?? null)) patch['terpeneProfile'] = trimOrNull(terpeneProfile.value)
  if (trimOrNull(nose.value) !== (p.nose ?? null)) patch['nose'] = trimOrNull(nose.value)
  return patch as ProductPatchInput
}

const canSubmit = computed(
  () => !saving.value && name.value.trim() !== '' && categoryId.value !== '',
)

async function submit() {
  if (!canSubmit.value) return
  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    emit('close')
    return
  }
  saving.value = true
  error.value = null
  try {
    await apiFetch(`/catalog/products/${props.product.id}`, { method: 'PATCH', body: patch })
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit {{ product.name }}</DialogTitle>
        <DialogDescription>
          Only what you change is saved. Renaming updates the catalog link automatically.
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
        <FieldGroup class="gap-4">
          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="pe-name">Name</FieldLabel>
              <Input id="pe-name" v-model="name" autocomplete="off" autofocus />
            </Field>
            <Field>
              <!--
                A real label pointing at the trigger's id, not a pseudo-label plus a duplicated
                aria-label: SelectTrigger renders a button, and `for` targets it perfectly well.
              -->
              <FieldLabel for="pe-category">Category</FieldLabel>
              <Select v-model="categoryId">
                <SelectTrigger id="pe-category" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="cat in leafCategories" :key="cat.id" :value="cat.id">
                    {{ cat.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="pe-brand">Brand</FieldLabel>
              <div v-if="newBrandMode" class="flex gap-1.5">
                <Input v-model="newBrandName" placeholder="Brand name" autocomplete="off" @keydown.enter.prevent="saveNewBrand" />
                <Button type="button" variant="outline" size="sm" class="h-9" @click="saveNewBrand">Save</Button>
              </div>
              <div v-else class="flex gap-1.5">
                <Select v-model="brandId">
                  <SelectTrigger id="pe-brand" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NONE">No brand</SelectItem>
                    <SelectItem v-for="brand in brandOptions" :key="brand.id" :value="brand.id">
                      {{ brand.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" variant="ghost" size="sm" class="h-9 shrink-0 px-2 text-xs text-primary" @click="newBrandMode = true">
                  ＋ New
                </Button>
              </div>
            </Field>
            <Field>
              <FieldLabel for="pe-supplier">Supplier</FieldLabel>
              <Select v-model="supplierId">
                <SelectTrigger id="pe-supplier" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE">No supplier</SelectItem>
                  <SelectItem v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id">
                    {{ supplier.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel for="pe-desc">
              Description <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="pe-desc" v-model="description" autocomplete="off" />
          </Field>

          <Field>
            <FieldLabel for="pe-coa">
              COA link <span class="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input id="pe-coa" v-model="coaUrl" autocomplete="off" placeholder="https://…" inputmode="url" />
          </Field>

          <FieldSet
            v-if="isFlower"
            class="gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3"
          >
            <FieldLegend class="text-[11px] font-semibold uppercase tracking-wider text-primary">
              Strain
            </FieldLegend>
            <div class="grid grid-cols-3 gap-2.5">
              <Field>
                <FieldLabel for="pe-strain-type" class="text-xs">Type</FieldLabel>
                <Select v-model="strainType">
                  <SelectTrigger id="pe-strain-type" class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NONE">—</SelectItem>
                    <SelectItem v-for="value in STRAIN_TYPE_VALUES" :key="value" :value="value">
                      {{ value.charAt(0) + value.slice(1).toLowerCase() }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel for="pe-terps" class="text-xs">Terpenes</FieldLabel>
                <Input id="pe-terps" v-model="terpeneProfile" class="h-8 text-xs" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="pe-nose" class="text-xs">Nose</FieldLabel>
                <Input id="pe-nose" v-model="nose" class="h-8 text-xs" autocomplete="off" />
              </Field>
            </div>
          </FieldSet>
        </FieldGroup>

        <FieldError v-if="error">{{ error }}</FieldError>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ saving ? 'Saving…' : 'Save changes' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
