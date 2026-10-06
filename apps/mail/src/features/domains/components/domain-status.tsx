import { StatusPill } from '@/components/common/status-pill'
import { type DomainStatus, domainPhase, PHASE_LABEL } from '../lib/status'

/** A domain's state as a pill, always in words (S8). */
export function DomainStatusPill({
  status,
  settingUp,
}: {
  status: DomainStatus
  settingUp: boolean
}) {
  const phase = domainPhase(status, settingUp)
  if (!phase) return null
  const { label, tone } = PHASE_LABEL[phase]
  return <StatusPill tone={tone}>{label}</StatusPill>
}
