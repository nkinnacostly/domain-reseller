import { isSesNotFound, type SesManager, type SesResult, sesResourceArn } from '@dr/shared/ses'
// Relative, not `@/`: the ops script runs this file outside Next (scripts/sandbox-identity.ts).
import { type DnsRecord, domainRecords } from '../../domains/lib/records'
import type { SandboxState } from '../queries/store'

/**
 * The shared sandbox sender (MAIL-SPEC §7.2 with MR2): one SES identity,
 * `sandbox.emails.mydomainshub.com`, made once by the ops script with the
 * manager key — its DNS is the owner's, in Cloudflare — and read by the job
 * route until SES verifies it (then daily). Once verified, provisioning joins
 * it to each sandbox account's own tenant (provision.ts), so a sandbox send
 * still names the account's tenant and set (MR1). It has no default
 * configuration set: every send names the account's.
 */

export const SANDBOX_NAME = 'sandbox.emails.mydomainshub.com'

/** What SES says of it, as `record_sandbox_identity` takes it. */
export async function readSandboxIdentity(
  manager: SesManager,
  where: { name: string; region: string; awsAccount: string },
): Promise<SesResult<{ state: SandboxState }>> {
  const identity = await manager.getEmailIdentity(where.name)
  if (!identity.ok) {
    return isSesNotFound(identity)
      ? {
          ok: true,
          state: { status: 'not_created', identityArn: null, dkimTokens: [], mailFromStatus: null },
        }
      : identity
  }
  return {
    ok: true,
    state: {
      status: identity.verifiedForSending
        ? 'verified'
        : identity.verificationStatus === 'FAILED'
          ? 'failed'
          : 'pending',
      identityArn: sesResourceArn(where.region, where.awsAccount, 'identity', where.name),
      dkimTokens: identity.dkimTokens,
      mailFromStatus: identity.mailFromStatus,
    },
  }
}

export type SandboxSetup = {
  /** What was done this run, in words for the operator. */
  did: string[]
  state: SandboxState
  records: DnsRecord[]
}

/**
 * The ops script's work: read the identity, and with `create`, make what is
 * missing — the identity with Easy DKIM (RSA 2048) and MAIL FROM on
 * send.<name>. Without `create` it only reads. Answers the DNS records to add.
 */
export async function ensureSandboxIdentity(
  manager: SesManager,
  where: { name: string; region: string; awsAccount: string },
  { create }: { create: boolean },
): Promise<SesResult<SandboxSetup>> {
  const did: string[] = []
  let identity = await manager.getEmailIdentity(where.name)
  if (!identity.ok && isSesNotFound(identity) && create) {
    const made = await manager.createEmailIdentity(where.name)
    if (!made.ok) return made
    did.push(`created the identity ${where.name} (Easy DKIM, RSA 2048)`)
    identity = await manager.getEmailIdentity(where.name)
  }
  if (!identity.ok) {
    if (!isSesNotFound(identity)) return identity
    did.push(`no identity ${where.name} in SES yet; run again with --create to make it`)
    return {
      ok: true,
      did,
      state: { status: 'not_created', identityArn: null, dkimTokens: [], mailFromStatus: null },
      records: [],
    }
  }
  const mailFrom = `send.${where.name}`
  if (identity.mailFromDomain !== mailFrom && create) {
    const put = await manager.putEmailIdentityMailFromAttributes(where.name, mailFrom)
    if (!put.ok) return put
    did.push(`set MAIL FROM to ${mailFrom}`)
  }
  const read = await readSandboxIdentity(manager, where)
  if (!read.ok) return read
  return {
    ok: true,
    did,
    state: read.state,
    records: domainRecords({
      name: where.name,
      dkimTokens: identity.dkimTokens,
      mailFromDomain: mailFrom,
      region: where.region,
    }),
  }
}
