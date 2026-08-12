export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'HEALTHY' ? 'badge-healthy'
    : status === 'DEGRADED' ? 'badge-degraded' : 'badge-unhealthy';
  return <span className={`badge ${cls}`} style={{ marginTop: 8 }}>{status}</span>;
}
