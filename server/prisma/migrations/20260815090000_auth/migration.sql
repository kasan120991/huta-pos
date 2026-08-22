-- DropIndex
DROP INDEX "User_storeId_pinLookup_key";

-- CreateTable
CREATE TABLE "TerminalPairingCode" (
    "id" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalPairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepUpGrant" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "terminalId" TEXT,
    "action" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalPairingCode_codeHash_key" ON "TerminalPairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "TerminalPairingCode_terminalId_idx" ON "TerminalPairingCode"("terminalId");

-- CreateIndex
CREATE INDEX "TerminalPairingCode_expiresAt_idx" ON "TerminalPairingCode"("expiresAt");

-- CreateIndex
CREATE INDEX "StepUpGrant_adminUserId_createdAt_idx" ON "StepUpGrant"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "StepUpGrant_expiresAt_idx" ON "StepUpGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "StepUpGrant_action_createdAt_idx" ON "StepUpGrant"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_storeId_name_key" ON "Terminal"("storeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "User_pinLookup_key" ON "User"("pinLookup");

-- AddForeignKey
ALTER TABLE "TerminalPairingCode" ADD CONSTRAINT "TerminalPairingCode_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalPairingCode" ADD CONSTRAINT "TerminalPairingCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data fix: staff are PIN-only from here on.
--
-- The seed previously gave staff a password hash as well as a PIN. Staff exist only at
-- the register, so a second credential is one more thing to leak for no benefit. This
-- must run BEFORE the constraint below, which would otherwise reject the existing rows.
-- ---------------------------------------------------------------------------
UPDATE "User" SET "passwordHash" = NULL WHERE "role" = 'STAFF';

-- ---------------------------------------------------------------------------
-- Credential invariants.
--
-- The existing User_role_store_scope_check covers WHERE someone works. These cover HOW
-- they authenticate, so a half-provisioned account cannot exist: an admin who can never
-- log in, or a staff member who can never attach at a register, are both bugs that
-- should fail at write time rather than at 8am on a Saturday.
-- ---------------------------------------------------------------------------

-- An ADMIN authenticates with email + password in the back office. A PIN is optional —
-- it exists only so an admin can also ring sales at a terminal.
ALTER TABLE "User" ADD CONSTRAINT "User_admin_credentials_check"
  CHECK (
    "role" <> 'ADMIN'
    OR ("email" IS NOT NULL AND "passwordHash" IS NOT NULL)
  );

-- A STAFF member authenticates ONLY with a PIN. No password, ever.
ALTER TABLE "User" ADD CONSTRAINT "User_staff_credentials_check"
  CHECK (
    "role" <> 'STAFF'
    OR ("pinHash" IS NOT NULL AND "passwordHash" IS NULL)
  );

-- A pairing code that expires before it is created is nonsense, and a consumed grant
-- must have been consumed within its own lifetime.
ALTER TABLE "TerminalPairingCode" ADD CONSTRAINT "TerminalPairingCode_window_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_window_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_action_check"
  CHECK (length("action") > 0);
