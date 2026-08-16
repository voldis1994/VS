export function SimplePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="card">
      <div className="welcome">{title}</div>
      <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)', fontFamily: 'inherit' }}>{body}</pre>
    </div>
  );
}
