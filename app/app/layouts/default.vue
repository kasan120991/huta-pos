<script setup lang="ts">
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar'
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset>
      <AppTopbar />
      <div class="flex flex-1 flex-col gap-4 p-4 pt-0">
        <slot />
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
