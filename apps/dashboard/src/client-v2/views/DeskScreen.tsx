import { LotControl } from '../components/LotControl';
import { MarketRail } from '../components/MarketRail';
import { PositionTicket } from '../components/PositionTicket';
import { RobotDial } from '../components/RobotDial';
import { StatusBar } from '../components/StatusBar';
import { useDeskContext } from '../DeskContext';

export function DeskScreen() {
  const d = useDeskContext();

  const hint = d.errorState
    ? d.status?.broker_error || d.status?.status_reason || 'System fault — tap to disarm'
    : d.starting
      ? 'Connecting market reader…'
      : d.requestedActive
        ? 'Tap core to disarm'
        : 'Tap core to arm robot';

  return (
    <div className="aurum-desk">
      <header className="aurum-header">
        <div>
          <p className="aurum-kicker">Client desk</p>
          <h1 className="aurum-header-title">{d.status?.client_name || '…'}</h1>
        </div>
        <button type="button" className="aurum-btn aurum-btn--ghost" onClick={() => void d.logout()}>
          Exit
        </button>
      </header>

      <main className="aurum-main">
        <section className="aurum-panel aurum-panel--hero">
          <RobotDial
            phase={d.status?.robot_status || 'STOPPED'}
            active={d.requestedActive}
            busy={d.busy}
            onToggle={() => void d.toggleRobot()}
            hint={hint}
          />
        </section>

        <div className="aurum-controls">
          <section className="aurum-panel">
            <p className="aurum-kicker">Instrument</p>
            <MarketRail
              markets={d.markets}
              epic={d.epic}
              locked={d.requestedActive || d.busy}
              onChange={(v) => void d.onMarketChange(v)}
            />
          </section>

          <section className="aurum-panel">
            <LotControl
              lot={d.lot}
              min={d.selected?.min_lot ?? 0.01}
              max={d.selected?.max_lot ?? 100}
              step={d.selected?.lot_step ?? 0.01}
              locked={d.requestedActive}
              busy={d.busy}
              onBump={(dir) => void d.bumpLot(dir)}
            />
          </section>
        </div>

        <section className="aurum-panel aurum-panel--ticket">
          <PositionTicket
            live={d.status?.live_trade ?? null}
            flash={d.flash}
            closedBanner={d.closedBanner}
            waiting={d.confirmedRunning}
            phase={d.status?.robot_status || 'STOPPED'}
          />
        </section>

        {d.error && <p className="aurum-error aurum-error--bar">{d.error}</p>}
      </main>

      <StatusBar
        linkOk={d.linkOk}
        online={d.online}
        broker={d.status?.broker_status}
        pipeline={d.status?.pipeline_healthy}
        clientName={d.status?.client_name}
      />
    </div>
  );
}
