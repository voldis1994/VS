import { useEffect, useRef } from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Delay focus so mobile keyboard opens after paint (Safari)
    const t = window.setTimeout(() => inputRef.current?.focus(), 280);
    return () => window.clearTimeout(t);
  }, []);

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
            ref={inputRef}
            id="access"
            className="aurum-input"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="one-time-code"
            enterKeyHint="go"
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
          Phone-ready · breakout only · your lot
        </p>
      </div>
    </div>
  );
}
