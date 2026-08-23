export function LoginScreen({
  accessCode,
  setAccessCode,
  loginError,
  busy,
  onLogin,
}: {
  accessCode: string;
  setAccessCode: (v: string) => void;
  loginError: string | null;
  busy: boolean;
  onLogin: () => void;
}) {
  return (
    <div className="aurum-login">
      <div className="aurum-login-card">
        <div className="aurum-brand">
          <div className="aurum-brand-mark" aria-hidden />
          <div>
            <h1 className="aurum-brand-title">AURUM</h1>
            <p className="aurum-brand-sub">Client command · VS</p>
          </div>
        </div>

        <label className="aurum-field" htmlFor="access">
          <span className="aurum-kicker">Access code</span>
          <input
            id="access"
            className="aurum-input"
            inputMode="text"
            autoComplete="one-time-code"
            placeholder="••••••••••••"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onLogin();
            }}
          />
        </label>

        {loginError && <p className="aurum-error">{loginError}</p>}

        <button type="button" className="aurum-btn aurum-btn--gold" disabled={busy} onClick={onLogin}>
          {busy ? 'Verifying…' : 'Enter desk'}
        </button>

        <p className="aurum-login-foot">
          Breakout execution only · your account · your lot
        </p>
      </div>
    </div>
  );
}
