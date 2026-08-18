export function StatusBadge({ status }: { status: string }) {
  const u = status.toUpperCase();
  const cls =
    u === 'HEALTHY' || u === 'LIVE' || u === 'OK'
      ? 'badge-healthy'
      : u === 'DEGRADED' || u === 'IDLE' || u === 'STALE'
        ? 'badge-degraded'
        : 'badge-unhealthy';
  return (
    <span className={`badge ${cls}`} style={{ marginTop: 8 }}>
      {status}
    </span>
  );
}
