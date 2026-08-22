<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue'
import { resolveNav } from '~/config/nav'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { SidebarTrigger } from '~/components/ui/sidebar'

const route = useRoute()
const { theme, toggle } = useTheme()

/** Resolves against the same nav array the sidebar renders, so they cannot drift. */
const crumb = computed(() => resolveNav(route.path))
</script>

<template>
  <header class="flex h-14 shrink-0 items-center gap-2 px-4">
    <SidebarTrigger class="-ml-1 mr-1" />
    <Breadcrumb v-if="crumb">
      <BreadcrumbList>
        <template v-if="crumb.group.label">
          <BreadcrumbItem class="hidden md:block">{{ crumb.group.label }}</BreadcrumbItem>
          <BreadcrumbSeparator class="hidden md:block" />
        </template>
        <BreadcrumbItem>
          <BreadcrumbPage>{{ crumb.item.title }}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
    <div class="ml-auto flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="toggle"
      >
        <Sun v-if="theme === 'dark'" />
        <Moon v-else />
      </Button>
    </div>
  </header>
</template>
