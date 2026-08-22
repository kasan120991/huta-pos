import type { Role } from '@huta/shared'
import type {
  AttachedUser,
  LoginRequest,
  PairedTerminal,
  RosterEntry,
  TerminalInfo,
  UserProfile,
} from '@huta/shared/schemas'
import { defineStore } from 'pinia'

import { ApiError, apiFetch } from '~/composables/useApi'

/**
 * Who is signed in.
 *
 * Mirrors `server/src/auth/principal.ts` exactly. Three shapes because a POS genuinely
 * has three: a person in the back office, a person attached at a register, and a register
 * with nobody on it.
 */
export type Principal =
  | { kind: 'admin'; userId: string; role: typeof Role.ADMIN; storeId: null; terminalId: string | null }
  | { kind: 'staff'; userId: string; role: typeof Role.STAFF; storeId: string; terminalId: string }
  | { kind: 'terminal'; userId: null; role: null; storeId: string; terminalId: string }

interface LoginResponse {
  user: { id: string; role: typeof Role.ADMIN }
  csrfToken: string
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    principal: null as Principal | null,
    /**
     * Who the person IS — name and email — as opposed to what they may do.
     *
     * Null for a bare terminal, which has nobody attached. Kept separate from `principal`
     * for the same reason the server keeps them apart: one is authorization, the other is
     * presentation.
     */
    user: null as UserProfile | null,
    /** WHERE the session is, by name. Null for a desk session. */
    terminal: null as TerminalInfo | null,
    /** Null until the first `/me` completes — distinct from "signed out". */
    resolved: false,
  }),

  getters: {
    isAuthenticated: (state): boolean => state.principal !== null,
    isAdmin: (state): boolean => state.principal?.kind === 'admin',

    /** "Huta Admin", or null when nobody is attached. */
    displayName: (state): string | null =>
      state.user ? `${state.user.firstName} ${state.user.lastName}`.trim() : null,

    /** Two letters for the avatar. Falls back to one when a name is a single word. */
    initials: (state): string =>
      state.user
        ? `${state.user.firstName.charAt(0)}${state.user.lastName.charAt(0)}`.toUpperCase()
        : '',

    /**
     * Are we at a register?
     *
     * Keyed on `terminalId`, NOT on role. An admin who attaches at a terminal is covering
     * the counter and belongs on the register surface, not the dashboard — which is
     * exactly the case the permission matrix allows for.
     */
    isAtTerminal: (state): boolean => state.principal?.terminalId != null,

    /** The device is paired but nobody has entered a PIN yet. */
    isUnattendedTerminal: (state): boolean => state.principal?.kind === 'terminal',

    /** "Main Store (Baytree) · Register 1", or null off the register surface. */
    registerLabel: (state): string | null =>
      state.terminal ? `${state.terminal.store.name} · ${state.terminal.name}` : null,
  },

  actions: {
    async login(credentials: LoginRequest): Promise<void> {
      // The server sets huta_at, huta_rt and huta_csrf. We keep none of them in JS —
      // the two that matter are httpOnly and the third is read from document.cookie
      // when a request needs it.
      await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: credentials,
      })
      await this.fetchPrincipal()
    },

    /**
     * Resolve the session from cookies. Safe to call on boot — a 401 just means signed
     * out, which is not an error worth surfacing.
     */
    async fetchPrincipal(): Promise<void> {
      try {
        const data = await apiFetch<{
          principal: Principal
          user: UserProfile | null
          terminal: TerminalInfo | null
        }>('/auth/me')
        this.principal = data.principal
        this.user = data.user
        this.terminal = data.terminal
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.principal = null
          this.user = null
          this.terminal = null
        } else {
          throw error
        }
      } finally {
        this.resolved = true
      }
    },

    /** Redeem a pairing code. The device token comes back as an httpOnly cookie. */
    async pairTerminal(code: string): Promise<PairedTerminal> {
      const paired = await apiFetch<PairedTerminal>('/auth/terminal/pair', {
        method: 'POST',
        body: { code },
      })
      await this.fetchPrincipal()
      return paired
    },

    /** Who may sign in here. Store scope comes from the device cookie, not from us. */
    async fetchRoster(): Promise<RosterEntry[]> {
      const data = await apiFetch<{ staff: RosterEntry[] }>('/auth/staff/roster')
      return data.staff
    },

    async attach(userId: string, pin: string): Promise<AttachedUser> {
      const data = await apiFetch<{ user: AttachedUser }>('/auth/staff/attach', {
        method: 'POST',
        body: { userId, pin },
      })
      await this.fetchPrincipal()
      return data.user
    },

    /** Sign the person out but leave the device paired — back to the roster, not to pairing. */
    async detach(): Promise<void> {
      try {
        await apiFetch<void>('/auth/staff/detach', { method: 'POST' })
      } finally {
        await this.fetchPrincipal()
      }
    },

    async logout(): Promise<void> {
      try {
        await apiFetch<void>('/auth/logout', { method: 'POST' })
      } finally {
        // Clear locally even if the call failed — the user asked to be signed out, and
        // leaving them looking signed in is the worse outcome.
        this.principal = null
        this.user = null
        this.terminal = null
      }
    },
  },
})
