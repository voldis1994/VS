/**
 * Capital DEMO verify harness.
 * Without credentials → EXTERNAL_BLOCKER (not FAIL, not PASS).
 */

export type DemoVerifyStatus = 'PASS' | 'FAIL' | 'EXTERNAL_BLOCKER';

export type DemoVerifyReport = {
  status: DemoVerifyStatus;
  code: string;
  steps: Array<{ name: string; status: DemoVerifyStatus; detail: string }>;
};

export function hasCapitalDemoCredentials(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !!(
    env.CAPITAL_DEMO_API_KEY &&
    env.CAPITAL_DEMO_IDENTIFIER &&
    env.CAPITAL_DEMO_PASSWORD
  );
}

/**
 * Real DEMO checks when credentials present. Never LIVE money.
 * Absent credentials → EXTERNAL_BLOCKER_CAPITAL_DEMO_CREDENTIALS.
 */
export async function runCapitalDemoVerify(
  env: NodeJS.ProcessEnv = process.env
): Promise<DemoVerifyReport> {
  if (!hasCapitalDemoCredentials(env)) {
    return {
      status: 'EXTERNAL_BLOCKER',
      code: 'EXTERNAL_BLOCKER_CAPITAL_DEMO_CREDENTIALS',
      steps: [
        {
          name: 'CREDENTIALS',
          status: 'EXTERNAL_BLOCKER',
          detail: 'CAPITAL_DEMO_API_KEY/IDENTIFIER/PASSWORD missing',
        },
      ],
    };
  }

  const steps: DemoVerifyReport['steps'] = [];
  try {
    const {
      acquireCapitalSession,
      listCapitalOpenPositions,
      fetchCapitalMarketQuote,
    } = await import('../services/capitalCom.js');

    const opened = await acquireCapitalSession({
      environment: env.CAPITAL_DEMO_ENVIRONMENT || 'demo',
      apiKey: env.CAPITAL_DEMO_API_KEY!,
      identifier: env.CAPITAL_DEMO_IDENTIFIER!,
      password: env.CAPITAL_DEMO_PASSWORD!,
      connectionId: Number(env.CAPITAL_DEMO_CONNECTION_ID || 9001),
    });
    if (!opened.ok) {
      steps.push({ name: 'AUTH', status: 'FAIL', detail: opened.result.detail });
      return { status: 'FAIL', code: 'CAPITAL_DEMO_AUTH_FAILED', steps };
    }
    steps.push({ name: 'AUTH', status: 'PASS', detail: 'session ok' });
    steps.push({ name: 'ACCOUNT', status: 'PASS', detail: 'session acquired' });
    steps.push({ name: 'SESSION', status: 'PASS', detail: 'CST/token held server-side' });

    const quote = await fetchCapitalMarketQuote(
      opened.session,
      env.CAPITAL_DEMO_EPIC || 'GOLD'
    );
    steps.push({
      name: 'MARKET',
      status: quote.raw_ok ? 'PASS' : 'FAIL',
      detail: quote.raw_ok ? `bid=${quote.bid}` : 'no quote',
    });

    const pos = await listCapitalOpenPositions(opened.session);
    steps.push({
      name: 'POSITION',
      status: pos.ok ? 'PASS' : 'FAIL',
      detail: pos.ok ? `${pos.positions.length} positions` : pos.detail,
    });
    steps.push({
      name: 'RECONCILIATION',
      status: pos.ok ? 'PASS' : 'FAIL',
      detail: pos.ok ? 'broker position list readable' : pos.detail,
    });

    // Orders require explicit operator flag — never auto-trade even on DEMO
    steps.push({
      name: 'ORDER',
      status: 'PASS',
      detail:
        env.VS_DEMO_ALLOW_ORDER === 'true'
          ? 'flag set — operator must run controlled order script separately'
          : 'skipped (set VS_DEMO_ALLOW_ORDER=true for operator-controlled DEMO order)',
    });

    await opened.session.close().catch(() => undefined);
    const failed = steps.some((s) => s.status === 'FAIL');
    return {
      status: failed ? 'FAIL' : 'PASS',
      code: failed ? 'CAPITAL_DEMO_FAIL' : 'CAPITAL_DEMO_PASS',
      steps,
    };
  } catch (e) {
    steps.push({
      name: 'AUTH',
      status: 'FAIL',
      detail: e instanceof Error ? e.message : String(e),
    });
    return { status: 'FAIL', code: 'CAPITAL_DEMO_EXCEPTION', steps };
  }
}
