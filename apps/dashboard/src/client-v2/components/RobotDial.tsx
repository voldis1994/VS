import type { DeskStatus } from '../types';

const LABELS: Record<DeskStatus['robot_status'], string> = {
  RUNNING: 'LIVE',
  STARTING: 'ARMING',
  STOPPED: 'STANDBY',
  ERROR: 'FAULT',
};

export function RobotDial({
  phase,
  active,
  busy,
  onToggle,
  hint,
}: {
  phase: DeskStatus['robot_status'];
  active: boolean;
  busy: boolean;
  onToggle: () => void;
  hint: string;
}) {
  return (
    <div className="aurum-dial-wrap">
      <button
        type="button"
        className={`aurum-dial phase-${phase.toLowerCase()}`}
        disabled={busy}
        onClick={onToggle}
        aria-label={active ? 'Stop robot' : 'Start robot'}
      >
        <span className="aurum-dial-ring aurum-dial-ring--outer" />
        <span className="aurum-dial-ring aurum-dial-ring--mid" />
        <span className="aurum-dial-core">
          <span className="aurum-dial-glyph">{active ? '■' : '▶'}</span>
        </span>
      </button>
      <div className={`aurum-dial-label phase-${phase.toLowerCase()}`}>{LABELS[phase]}</div>
      <p className="aurum-dial-hint">{hint}</p>
    </div>
  );
}
