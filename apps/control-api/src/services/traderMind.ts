/**
 * Human trader mind — thinks in words like a person at the desk,
 * not a filter ladder or blind score.
 *
 * Flow (same as a trader):
 *  1) What do I see? (situation)
 *  2) What do I believe? (thesis)
 *  3) What can hurt me? (risk)
 *  4) What do I do now? (decision + why)
 *
 * Soft HardInv remains the hard floor outside this mind.
 */
import type { ExitSide } from './exitManage.js';
import {
  pressureFightsSide,
  storyFightsSide,
  type MarketContextSnapshot,
} from './marketContext.js';
import type { ManageBrainAction, ManageBrainInput } from './manageBrain.js';

export type TraderThought = {
  situation: string;
  thesis: string;
  risk: string;
  decision: ManageBrainAction;
  why: string;
  /** One line for MANAGE tick */
  spoken: string;
  confidence: number;
};

export type SessionLesson = {
  diagnosis: string;
  lesson: string;
  /** Peak/Target/TP only — never entry filters */
  intent:
    | 'ease_peak_target'
    | 'let_winners_run'
    | 'protect_sooner'
    | 'hold_course';
};

function sideWord(side: ExitSide): string {
  return side === 'BUY' ? 'pircējs (BUY)' : 'pārdevējs (SELL)';
}

/**
 * Deliberate like a human trader on an open position.
 */
export function thinkLikeTrader(input: ManageBrainInput): TraderThought {
  const soft = Math.max(input.soft_sl, 1e-9);
  const mfe = Math.max(0, input.mfe);
  const mae = Math.max(0, input.mae);
  const upl = input.unrealized;
  const mkt = input.market;
  const retention =
    input.peak_retention != null && Number.isFinite(input.peak_retention)
      ? input.peak_retention
      : mfe > 0
        ? Math.max(0, upl / mfe)
        : 1;

  const chapter = mkt?.story?.chapter || 'NEZINĀMS';
  const zone = mkt?.zone?.band || '—';
  const g = mkt?.pressure.green_1m ?? 0;
  const r = mkt?.pressure.red_1m ?? 0;
  const expand = mkt?.velocity.expanding
    ? 'tirgus PAĀTRINĀS'
    : mkt?.velocity.compressed
      ? 'tirgus saspiests'
      : 'temps normāls';
  const feed = mkt?.feed?.agreement || 'nav';

  // 1) Situation — what a human sees on the screen
  const uplTag =
    upl >= soft
      ? `plusā +${upl.toFixed(2)} (jau Soft izmērs)`
      : upl > 0
        ? `mazā plusā +${upl.toFixed(2)}`
        : `mīnusā ${upl.toFixed(2)}`;
  const situation = `Esmu ${sideWord(input.open_side)} · ${uplTag} · MFE ${mfe.toFixed(
    2
  )} / MAE ${mae.toFixed(2)} · 30m stāsts ${chapter} zona ${zone} · sveces G${g}/R${r} · ${expand} · feed ${feed} · 1m ${input.minute_policy}`;

  // 2) Thesis — what I believe is happening
  const withUs =
    mkt &&
    (mkt.story?.allow === input.open_side || mkt.story?.allow === 'BOTH') &&
    !storyFightsSide(mkt.story?.allow, input.open_side);
  const againstUs =
    (mkt && storyFightsSide(mkt.story?.allow, input.open_side)) ||
    (mkt && pressureFightsSide(mkt.pressure.green_share, input.open_side)) ||
    input.minute_policy === 'reverse' ||
    Boolean(input.next_entry_side && input.next_entry_side !== input.open_side);

  let thesis: string;
  if (input.minute_policy === 'continue' && withUs) {
    thesis = `Kustība vēl iet manā virzienā — 1m continue un stāsts ${chapter} man līdzās. Ļauju peļņai strādāt.`;
  } else if (againstUs && mfe >= soft * 0.75) {
    thesis = `Tirgus mainās pret mani (stāsts/pressure/1m). Man jau bija labs MFE — sāku domāt kā aizstāvēt peļņu, necerēt uz brīnumu.`;
  } else if (againstUs) {
    thesis = `Attēls pagriežas pret manu ${input.open_side}. Bez liela MFE esmu piesardzīgs — Soft ir mana pēdējā līnija.`;
  } else if (mfe >= soft && upl >= soft * 0.85) {
    thesis = `Esmu spēcīgā plusā. Kamēr 1m un stāsts neteic pretējo, turu un ļauju Peak/Target strādāt.`;
  } else {
    thesis = `Vēl nav skaidra uzvara vai sakāve — skatos zonu, pressure un nākamo sveci; Soft sargā zaudētāju.`;
  }

  // 3) Risk — what can hurt me
  const risks: string[] = [];
  if (mfe > soft && retention < 0.55 && upl > 0) {
    risks.push(`peļņa jau atdota (~${((1 - retention) * 100).toFixed(0)}% no MFE)`);
  }
  if (mkt && storyFightsSide(mkt.story?.allow, input.open_side)) {
    risks.push(`30m stāsts atļauj pretējo pusi (${mkt.story?.allow})`);
  }
  if (mkt && pressureFightsSide(mkt.pressure.green_share, input.open_side)) {
    risks.push(`vairāk pretējo sveču (G${g}/R${r})`);
  }
  if (mkt?.feed?.agreement === 'DIVERGENT') {
    risks.push('feedi nesakrīt — cena var būt maldīga');
  }
  if (input.session_expectancy_pts < -0.2 && input.closes_in_session >= 3) {
    risks.push(`šodien E=${input.session_expectancy_pts.toFixed(2)} — sesija vāja`);
  }
  if (
    input.entry_market?.story?.chapter &&
    mkt?.story?.chapter &&
    input.entry_market.story.chapter !== mkt.story.chapter
  ) {
    risks.push(
      `stāsts mainījies ${input.entry_market.story.chapter}→${mkt.story.chapter}`
    );
  }
  const risk = risks.length
    ? risks.join('; ')
    : 'īpaša sarkana karoga nav — Soft joprojām sargā';

  // 4) Decision — what a careful human would do now
  let decision: ManageBrainAction = 'TRAIL';
  let why: string;
  let confidence = 0.55;

  const greenSoft = upl >= soft * 0.95 && mfe >= soft;
  const marketChanged =
    input.minute_policy === 'reverse' ||
    Boolean(input.next_entry_side && input.next_entry_side !== input.open_side) ||
    (mkt != null && storyFightsSide(mkt.story?.allow, input.open_side));

  if (input.minute_policy === 'continue' && !againstUs) {
    decision = 'HOLD';
    why =
      'Cilvēks teiktu: neaiztiec — svece vēl iet manā virzienā. Peak trail gatavs, Target pagaida.';
    confidence = 0.8;
  } else if (greenSoft && marketChanged) {
    decision = 'BANK';
    why =
      'Man ir Soft izmēra peļņa un tirgus jau pagriežas. Bankoju kā cilvēks, kas neļauj plusam kļūt par nulli.';
    confidence = 0.85;
  } else if (mfe >= soft * 0.75 && (againstUs || retention < 0.55)) {
    decision = 'CUT';
    why =
      'Biju plusā, tagad atdodu — ciešākais Peak trail, lai neaizietu atpakaļ uz Soft zaudējumu.';
    confidence = 0.75;
  } else if (againstUs && mfe < soft * 0.5) {
    decision = 'HOLD';
    why =
      'Attēls slikts, bet vēl nav ko bankot. Soft nogriezīs, ja kļūs īsts zaudētājs — es negriežu panikā.';
    confidence = 0.6;
  } else {
    decision = 'TRAIL';
    why =
      'Nav skaidra «ņem» vai «turi bezgalīgi» — sekoju Peak trail kā disciplīnēts traders.';
    confidence = 0.65;
  }

  const spoken = `PRĀTS ${decision} · ${thesis.slice(0, 120)}${thesis.length > 120 ? '…' : ''} · ${why.slice(0, 100)}${why.length > 100 ? '…' : ''}`;

  return { situation, thesis, risk, decision, why, spoken, confidence };
}

/**
 * After 5 closes — think like a human reviewing the day.
 * Changes Peak/Target/TP intent only — never entry filters.
 */
export function reviewSessionLikeHuman(
  trades: Array<{
    pnl_pts: number;
    exit_reason: string | null;
    mfe: number;
    mae: number;
    entry_ctx?: { chapter?: string | null } | null;
  }>
): SessionLesson {
  if (!trades.length) {
    return {
      diagnosis: 'Nav darījumu ko vērtēt.',
      lesson: 'Turpinu ar pašreizējiem Soft/Peak/Target.',
      intent: 'hold_course',
    };
  }

  const sum = trades.reduce((a, t) => a + t.pnl_pts, 0);
  const e = sum / trades.length;
  const softLosses = trades.filter((t) =>
    /HardInvalidation|HardInv/i.test(String(t.exit_reason || ''))
  );
  const peakTiny = trades.filter(
    (t) =>
      /PeakProtection|TimeDecay|Target/i.test(String(t.exit_reason || '')) &&
      t.mfe > 1e-6 &&
      t.pnl_pts > 0 &&
      t.pnl_pts < t.mfe * 0.35
  );
  const leftOnTable = peakTiny.length >= 2;
  const knifeSoft =
    softLosses.filter((t) => {
      const ch = String(t.entry_ctx?.chapter || '').toUpperCase();
      return (
        ch === 'BOUNCE_IN_SELL' ||
        ch === 'DIP_IN_RALLY' ||
        ch === 'EXHAUST_HI' ||
        ch === 'EXHAUST_LO' ||
        ch === 'RANGE_CHOP'
      );
    }).length >= 2;

  if (leftOnTable && e < 0.25) {
    return {
      diagnosis: `Logs E=${e.toFixed(2)}. ${peakTiny.length}× Peak/Target bankoja sīku daļu no MFE — plusi tika nogriezti pārāk agri vai pārāk tālu mērķi.`,
      lesson:
        'Kā cilvēks: neceļu Peak vēl augstāk. Atviegloju Peak/Target, lai peļņa tiktu ielikta kontā, pirms Soft apēd.',
      intent: 'ease_peak_target',
    };
  }

  if (knifeSoft && softLosses.length >= 2) {
    return {
      diagnosis: `Logs E=${e.toFixed(2)}. Soft zaudējumi pēc sliktām 30m nodaļām (knife/chop) — ienācu pret stāstu, nevis Peak bija par zemu.`,
      lesson:
        'Kā cilvēks: nemainu filtrus. Peak/Target neceļu. Aizsargājos ātrāk nākamajos darījumos (ciešāks Peak trail), Soft paliek.',
      intent: 'protect_sooner',
    };
  }

  if (e < 0 && softLosses.length >= 2) {
    return {
      diagnosis: `Logs E=${e.toFixed(2)}. Soft zaudējumi lielāki par to, ko Peak/Target atnes — R:R apgriezts.`,
      lesson:
        'Vai nu Peak/Target jābūt sasniedzamākiem (ease), vai jālauj uzvarētājiem skriet — bet ne filtri.',
      intent: leftOnTable ? 'ease_peak_target' : 'ease_peak_target',
    };
  }

  if (e >= 0.25) {
    return {
      diagnosis: `Logs E=${e.toFixed(2)} pozitīvs — pieeja strādā.`,
      lesson: 'Nelielas Peak korekcijas ok; Soft netieku. Filtrus neaiztieku.',
      intent: 'let_winners_run',
    };
  }

  return {
    diagnosis: `Logs E=${e.toFixed(2)} — jaukti rezultāti.`,
    lesson: 'Turpinu Soft/Peak/Target kursu; mācos no nākamā loga.',
    intent: 'hold_course',
  };
}
