-- Staff administration: an admin can now create staff, reset a PIN and clear a lockout.
--
-- One column. When an admin resets someone's PIN the system generates a temporary one and
-- sets this flag; the register forces a change at the next sign-in and clears it. No CHECK
-- constraint accompanies it — unlike the four that already govern User, there is no invalid
-- combination here to police.
ALTER TABLE "User" ADD COLUMN "mustChangePin" BOOLEAN NOT NULL DEFAULT false;
