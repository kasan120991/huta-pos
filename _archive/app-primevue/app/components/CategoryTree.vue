<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * The category filter, as a tree.
 *
 * This exists because the flat chip row could not express the taxonomy it was built on.
 * Every real parent holds zero products DIRECTLY — products are filed on the leaves — and
 * the chip row hid any facet whose count was zero, so Inhalables, Ingestibles, Topicals,
 * Accessories and Other Botanicals never rendered at all. `expandCategoryIds` on the
 * server, written specifically so that selecting a parent selects its children, had no
 * control in the UI that could invoke it.
 *
 * Counts here are ROLLED UP, so a parent's number describes what selecting it returns.
 */

export interface CategoryNode {
  id: string
  name: string
  slug: string
  parentId: string | null
  productCount: number
  directProductCount: number
  children?: CategoryNode[]
}

const props = defineProps<{
  tree: ReadonlyArray<CategoryNode & { children: CategoryNode[] }>
  selected: readonly string[]
}>()

const emit = defineEmits<{ toggle: [id: string] }>()

/**
 * Branch open/closed state.
 *
 * A branch is open by default when anything inside it is selected — restoring a shared URL
 * must never leave a live filter hidden inside a collapsed node. An explicit click
 * overrides that default for as long as the page lives.
 */
const overrides = ref(new Map<string, boolean>())

const openByDefault = computed(() => {
  const open = new Set<string>()
  for (const parent of props.tree) {
    const selectedInside =
      props.selected.includes(parent.id) ||
      parent.children.some((c) => props.selected.includes(c.id))
    if (selectedInside) open.add(parent.id)
  }
  return open
})

function isOpen(id: string): boolean {
  return overrides.value.get(id) ?? openByDefault.value.has(id)
}

function toggleOpen(id: string): void {
  overrides.value = new Map(overrides.value).set(id, !isOpen(id))
}
</script>

<template>
  <div class="tree" role="group" aria-label="Filter by category">
    <template v-for="parent in props.tree" :key="parent.id">
      <div class="row">
        <!--
          A parent with children gets a disclosure control separate from its filter
          control. Merging them would make "show me what is in here" and "filter to
          everything in here" the same click, and they are different intentions.
        -->
        <button
          v-if="parent.children.length > 0"
          type="button"
          class="caret"
          :aria-expanded="isOpen(parent.id)"
          :aria-label="`${isOpen(parent.id) ? 'Collapse' : 'Expand'} ${parent.name}`"
          @click="toggleOpen(parent.id)"
        >
          {{ isOpen(parent.id) ? '▾' : '▸' }}
        </button>
        <span v-else class="caret spacer" aria-hidden="true" />

        <button
          type="button"
          class="node parent"
          :class="{ on: props.selected.includes(parent.id) }"
          :aria-pressed="props.selected.includes(parent.id)"
          @click="emit('toggle', parent.id)"
        >
          <span class="name">{{ parent.name }}</span>
          <span class="n">{{ parent.productCount }}</span>
        </button>
      </div>

      <div v-if="isOpen(parent.id)" class="kids">
        <button
          v-for="child in parent.children"
          :key="child.id"
          type="button"
          class="node kid"
          :class="{ on: props.selected.includes(child.id) }"
          :aria-pressed="props.selected.includes(child.id)"
          @click="emit('toggle', child.id)"
        >
          <span class="name">{{ child.name }}</span>
          <span class="n">{{ child.productCount }}</span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}

.row {
  display: flex;
  align-items: stretch;
  gap: 0.1rem;
}

.caret {
  flex: 0 0 1rem;
  font: inherit;
  /* Not smaller than this: at 0.625rem the triangle reads as a bullet, which says "list
     item" rather than "there is more inside me". */
  font-size: 0.8125rem;
  line-height: 1;
  color: var(--p-text-muted-color);
  background: none;
  border: 0;
  border-radius: 0.25rem;
  cursor: pointer;
  padding: 0;
}

.caret.spacer {
  cursor: default;
}

.caret:focus-visible,
.node:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

.node {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0.35rem;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  color: var(--p-text-color);
  background: none;
  border: 0;
  border-radius: 0.25rem;
  cursor: pointer;
}

.node:hover {
  background: var(--p-surface-100);
}

.app-dark .node:hover {
  background: var(--p-surface-800);
}

.node.parent {
  font-weight: 600;
}

.kids {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  margin-left: 1.1rem;
}

.node.on {
  background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
  color: var(--p-primary-color);
  font-weight: 620;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.n {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.node.on .n {
  color: var(--p-primary-color);
  opacity: 0.75;
}
</style>
