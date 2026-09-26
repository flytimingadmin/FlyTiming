import { RACE_STATUS_LABEL, type RaceStatus } from '../lib/types'

export default function StatusBadge({ status }: { status: RaceStatus }) {
  return <span className={`badge badge-${status}`}>{RACE_STATUS_LABEL[status]}</span>
}
