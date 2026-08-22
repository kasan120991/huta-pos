<script setup lang="ts">
import type { CatalogReference, ProductCreateResult } from '@huta/shared/schemas'
import type { PriceGroupRow } from '@huta/shared/schemas'
import type { Cents } from '@huta/shared'
import { FLOWER_CATEGORY_SLUG, FLOWER_PRICE_GROUP_SLUG, STRAIN_TYPE_VALUES, formatCents } from '@huta/shared'
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * Create a product with its required first variant — one dialog, everything visible.
 *
 * The dialog is UNIVERSAL, not flower-only: the strain block appears only when the
 * chosen category sits under Flower, and the Sold-by toggle flips the pricing half —
 * EACH shows a plain price field, WEIGHT shows the price-group select. The two are
 * mutually exclusive by construction, mirroring the server's pricing-shape rule so it
 * never has to reject one.
 */
const props = defineProps<{
  open: boolean
  reference: CatalogReference
}>()
const emit = defineEmits<{ close: [] }>()

const name = ref('')
const categoryId = ref('')
const brandId = ref('')
const description = ref('')
const strainType = ref('')
const terpeneProfile = ref('')
const nose = ref('')
const sku = ref('')
const barcode = ref('')
const mode = ref<'EACH' | 'WEIGHT'>('EACH')
const priceDollars = ref('')
const priceGroupId = ref('')
const newBrandMode = ref(false)
const newBrandName = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = ''
      categoryId.value = ''
      brandId.value = ''
      description.value = ''
      strainType.value = ''
      terpeneProfile.value = ''
      nose.value = ''
      sku.value = ''
      barcode.value = ''
      mode.value = 'EACH'
      priceDollars.value = ''
      priceGroupId.value = ''
      newBrandMode.value = false
      newBrandName.value = ''
      error.value = null
    }
  },
)

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

/** Is the chosen category inside the Flower subtree? Walk the parent chain by slug. */
const isFlower = computed(() => {
  const byId = new Map(props.reference.categories.map((c) => [c.id, c]))
  let current = byId.get(categoryId.value)
  while (current) {
    if (current.slug === FLOWER_CATEGORY_SLUG) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
})

/* Flower defaults to selling by weight; everything else by unit. Only a default — the
   toggle stays in the admin's hands. */
watch(isFlower, (flower) => {
  mode.value = flower ? 'WEIGHT' : 'EACH'
})

/* Price groups, fetched once the first time WEIGHT is chosen. */
const groups = ref<PriceGroupRow[] | null>(null)
watch(mode, async (m) => {
  if (m !== 'WEIGHT' || groups.value !== null) return
  const data = await apiFetch<{ groups: PriceGroupRow[] }>('/pricing/groups')
  groups.value = data.groups.filter((g) => g.active)
  if (!priceGroupId.value) {
    const flower = groups.value.find((g) => g.slug === FLOWER_PRICE_GROUP_SLUG)
    if (flower) priceGroupId.value = flower.id
  }
})

/** Dollars string → integer cents, parsed from the digits — never a float multiply. */
const priceCents = computed<number | null>(() => {
  const raw = priceDollars.value.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  const [whole, frac = ''] = raw.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
})

const canSubmit = computed(
  () =>
    !submitting.value
    && name.value.trim() !== ''
    && categoryId.value !== ''
    && sku.value.trim() !== ''
    && (mode.value === 'EACH' ? priceCents.value !== null : priceGroupId.value !== ''),
)

/** Brands created inside this dialog session — merged ahead of the reference list. */
const createdBrands = ref<Array<{ id: string, name: string }>>([])
const brandOptions = computed(() => [...createdBrands.value, ...props.reference.brands])

async function saveNewBrand() {
  const brandName = newBrandName.value.trim()
  if (!brandName) return
  const brand = await apiFetch<{ id: string, name: string }>('/catalog/brands', {
    method: 'POST',
    body: { name: brandName },
  })
  createdBrands.value.push(brand)
  brandId.value = brand.id
  newBrandMode.value = false
  newBrandName.value = ''
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = null
  try {
    const created = await apiFetch<ProductCreateResult>('/catalog/products', {
      method: 'POST',
      body: {
        name: name.value.trim(),
        categoryId: categoryId.value,
        ...(brandId.value ? { brandId: brandId.value } : {}),
        ...(description.value.trim() ? { description: description.value.trim() } : {}),
        ...(isFlower.value && strainType.value ? { strainType: strainType.value } : {}),
        ...(isFlower.value && terpeneProfile.value.trim() ? { terpeneProfile: terpeneProfile.value.trim() } : {}),
        ...(isFlower.value && nose.value.trim() ? { nose: nose.value.trim() } : {}),
        variant: {
          sku: sku.value.trim(),
          ...(barcode.value.trim() ? { barcode: barcode.value.trim() } : {}),
          trackingMode: mode.value,
          ...(mode.value === 'EACH'
            ? { priceCents: priceCents.value }
            : { priceGroupId: priceGroupId.value }),
        },
      },
    })
    emit('close')
    await navigateTo(`/catalog/products/${created.id}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => !o && emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add product</DialogTitle>
        <DialogDescription>
          Creates the product with its first variant — more variants can follow on the product page.
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
        <FieldGroup class="gap-4">
          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="np-name">Name</FieldLabel>
              <Input id="np-name" v-model="name" autocomplete="off" autofocus />
            </Field>
            <Field>
              <FieldLabel for="np-category">Category</FieldLabel>
              <Select v-model="categoryId">
                <SelectTrigger id="np-category" class="w-full">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
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
              <FieldLabel for="np-brand">
                Brand <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <div v-if="newBrandMode" class="flex gap-1.5">
                <Input v-model="newBrandName" placeholder="Brand name" autocomplete="off" @keydown.enter.prevent="saveNewBrand" />
                <Button type="button" variant="outline" size="sm" class="h-9" @click="saveNewBrand">Save</Button>
              </div>
              <div v-else class="flex gap-1.5">
                <Select v-model="brandId">
                  <SelectTrigger id="np-brand" class="w-full">
                    <SelectValue placeholder="No brand" />
                  </SelectTrigger>
                  <SelectContent>
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
              <FieldLabel for="np-desc">
                Description <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="np-desc" v-model="description" autocomplete="off" />
            </Field>
          </div>

          <FieldSet v-if="isFlower" class="gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
            <FieldLegend class="text-[11px] font-semibold uppercase tracking-wider text-primary">
              Strain
            </FieldLegend>
            <div class="grid grid-cols-3 gap-2.5">
              <Field>
                <FieldLabel for="np-strain-type" class="text-xs">Type</FieldLabel>
                <Select v-model="strainType">
                  <SelectTrigger id="np-strain-type" class="h-8 w-full text-xs">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="value in STRAIN_TYPE_VALUES" :key="value" :value="value">
                      {{ value.charAt(0) + value.slice(1).toLowerCase() }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel for="np-terps" class="text-xs">Terpenes</FieldLabel>
                <Input id="np-terps" v-model="terpeneProfile" class="h-8 text-xs" autocomplete="off" />
              </Field>
              <Field>
                <FieldLabel for="np-nose" class="text-xs">Nose</FieldLabel>
                <Input id="np-nose" v-model="nose" class="h-8 text-xs" autocomplete="off" />
              </Field>
            </div>
          </FieldSet>

          <FieldSeparator>First variant</FieldSeparator>

          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="np-sku">SKU</FieldLabel>
              <Input id="np-sku" v-model="sku" autocomplete="off" class="font-mono" />
            </Field>
            <Field>
              <FieldLabel for="np-barcode">
                Barcode <span class="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id="np-barcode" v-model="barcode" autocomplete="off" placeholder="Scan or type…" />
            </Field>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel id="np-soldby-label">Sold by</FieldLabel>
              <ToggleGroup
                :model-value="mode"
                type="single"
                variant="outline"
                aria-labelledby="np-soldby-label"
                class="w-fit"
                @update:model-value="(v) => v && (mode = v as 'EACH' | 'WEIGHT')"
              >
                <ToggleGroupItem value="EACH" class="px-4">Each</ToggleGroupItem>
                <ToggleGroupItem value="WEIGHT" class="px-4">Weight</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field v-if="mode === 'EACH'">
              <FieldLabel for="np-price">Price</FieldLabel>
              <InputGroup class="h-8">
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput id="np-price" v-model="priceDollars" inputmode="decimal" autocomplete="off" class="tabular-nums" />
              </InputGroup>
            </Field>
            <Field v-else>
              <FieldLabel for="np-group">Price group</FieldLabel>
              <Select v-model="priceGroupId">
                <SelectTrigger id="np-group" class="w-full">
                  <SelectValue placeholder="Pick a group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="group in groups ?? []" :key="group.id" :value="group.id">
                    {{ group.name }} · {{ formatCents(group.basePricePerGramCents as Cents) }}/g base
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </FieldGroup>

        <FieldDescription>
          <template v-if="mode === 'WEIGHT'">
            Weight variants price through their group — rates and tiers live on the Pricing page.
          </template>
          Cost arrives with the first receipt, never typed here.
        </FieldDescription>

        <FieldError v-if="error">{{ error }}</FieldError>

        <DialogFooter class="items-center">
          <span class="mr-auto text-xs text-muted-foreground">Active on create</span>
          <Button type="button" variant="ghost" @click="emit('close')">Cancel</Button>
          <Button type="submit" :disabled="!canSubmit">
            {{ submitting ? 'Creating…' : 'Create product' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
