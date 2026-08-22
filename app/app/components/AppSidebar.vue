<script setup lang="ts">
import { ChevronsUpDown, LogOut } from '@lucide/vue'
import { NAV, resolveNav } from '~/config/nav'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { useAuthStore } from '~/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const { isMobile } = useSidebar()

const activeItem = computed(() => resolveNav(route.path)?.item)

async function signOut() {
  await auth.logout()
  await navigateTo('/login', { replace: true })
}
</script>

<template>
  <Sidebar variant="floating" collapsible="icon">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton as-child size="lg">
            <NuxtLink to="/">
              <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 3c4 3 6 7 6 11a6 6 0 0 1-12 0c0-4 2-8 6-11Z" stroke="currentColor" stroke-width="1.6" />
                  <path d="M12 8v11" stroke="currentColor" stroke-width="1.6" />
                </svg>
              </div>
              <span class="font-semibold tracking-tight">Huta</span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup v-for="group in NAV" :key="group.label ?? 'top'">
        <SidebarGroupLabel v-if="group.label">{{ group.label }}</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem v-for="item in group.items" :key="item.to">
            <SidebarMenuButton
              as-child
              :is-active="item === activeItem"
              :tooltip="item.title"
            >
              <NuxtLink :to="item.to">
                <component :is="item.icon" :class="item === activeItem ? 'text-primary' : ''" />
                <span>{{ item.title }}</span>
              </NuxtLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <SidebarMenuButton
                size="lg"
                class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar class="size-8 rounded-lg">
                  <AvatarFallback class="rounded-lg">{{ auth.initials || '·' }}</AvatarFallback>
                </Avatar>
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <span class="truncate font-medium">{{ auth.displayName }}</span>
                  <span class="truncate text-xs text-muted-foreground">{{ auth.user?.email }}</span>
                </div>
                <ChevronsUpDown class="ml-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              :side="isMobile ? 'bottom' : 'right'"
              align="end"
              :side-offset="4"
            >
              <DropdownMenuLabel class="p-0 font-normal">
                <div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar class="size-8 rounded-lg">
                    <AvatarFallback class="rounded-lg">{{ auth.initials || '·' }}</AvatarFallback>
                  </Avatar>
                  <div class="grid flex-1 text-left text-sm leading-tight">
                    <span class="truncate font-semibold">{{ auth.displayName }}</span>
                    <span class="truncate text-xs text-muted-foreground">{{ auth.user?.email }}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem @click="signOut">
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
</template>
