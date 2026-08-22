<script setup lang="ts">
import { ChevronsUpDown } from '@lucide/vue'
import { Badge } from '~/components/ui/badge'
import { Checkbox } from '~/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

export interface FilterChipItem {
  id: string
  name: string
  count?: number
  /** Tree indent level — categories only. */
  depth?: number
  /** Checked because a parent is selected; shown checked but not directly toggleable. */
  implied?: boolean
}

const props = defineProps<{
  label: string
  items: FilterChipItem[]
  selected: string[]
  /** Small print under the list — e.g. the AND rule for cannabinoids. */
  footnote?: string
  /** Register styling: rounded-full h-9 trigger and roomier touch rows. */
  pill?: boolean
}>()

const emit = defineEmits<{ toggle: [id: string], clear: [] }>()

const selectedCount = computed(() => props.selected.length)
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 border bg-transparent text-sm transition-colors"
        :class="[
          pill
            ? 'h-9 rounded-full px-3.5 font-medium'
            : 'h-8 rounded-lg border-dashed border-input px-3',
          selectedCount
            ? pill
              ? 'border-primary/50 bg-primary/12 text-primary'
              : 'border-solid border-primary/50 text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        ]"
      >
        {{ label }}
        <Badge v-if="selectedCount" variant="secondary" class="h-5 min-w-5 justify-center px-1 text-xs">
          {{ selectedCount }}
        </Badge>
        <ChevronsUpDown v-else class="size-3.5 opacity-60" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-2">
      <div class="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        <label
          v-for="item in items"
          :key="item.id"
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
          :class="[pill ? 'py-2.5' : 'py-1.5', item.implied ? 'cursor-default opacity-60' : '']"
          :style="item.depth ? { paddingLeft: `${8 + item.depth * 16}px` } : undefined"
        >
          <Checkbox
            :model-value="item.implied || selected.includes(item.id)"
            :disabled="item.implied"
            @update:model-value="emit('toggle', item.id)"
          />
          <span class="flex-1 truncate">{{ item.name }}</span>
          <span v-if="item.count !== undefined" class="text-xs text-muted-foreground tabular-nums">
            {{ item.count }}
          </span>
        </label>
      </div>
      <p v-if="footnote" class="mt-2 border-t px-2 pt-2 text-xs text-muted-foreground">
        {{ footnote }}
      </p>
      <button
        v-if="selectedCount"
        type="button"
        class="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
        @click="emit('clear')"
      >
        Clear
      </button>
    </PopoverContent>
  </Popover>
</template>
