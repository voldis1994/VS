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

export type EntryChoice = 'BUY' | 'SELL' | 'WAIT';

export type EntryThought = {
  choice: EntryChoice;
  situation: string;
  thesis: string;
  why: string;
  spoken: string;
  confidence: number;
};

export type EntryMindInput = {
  regime?: string | null;
  chapter: string;
  allow: string;
  story_conf: number;
  story_summary?: string | null;
  red_1m?: number;
  green_1m?: number;
  zone_pos?: number | null;
  /** Last closed 10s body sign: -1 sell pressure, +1 buy */
  bar_body_sign?: -1 | 0 | 1;
  last_closed_side?: 'BUY' | 'SELL' | null;
  last_close_was_loss?: boolean;
};

/**
 * Entry mind — chooses BUY / SELL / WAIT from live info.
 * Not a block list: picks the side the picture supports, or waits.
 */
export function thinkEntryLikeTrader(input: EntryMindInput): EntryThought {
  const chapter = String(input.chapter || 'NEZINĀMS').toUpperCase();
  const allow = String(input.allow || 'NONE').toUpperCase();
  const regime = String(input.regime || 'UNKNOWN').toUpperCase();
  const g = input.green_1m ?? 0;
  const r = input.red_1m ?? 0;
  const conf = Number.isFinite(input.story_conf) ? input.story_conf : 0;
  const pos = input.zone_pos;
  const body = input.bar_body_sign ?? 0;
  const storyLine = input.story_summary || `STĀSTS · ${chapter}`;

  const situation = `Flat · regime ${regime} · ${storyLine} · allow ${allow} · G${g}/R${r} · zona ${
    pos != null && Number.isFinite(pos) ? pos.toFixed(2) : '—'
  } · 10s ${body > 0 ? 'zaļš' : body < 0 ? 'sarkans' : 'kluss'}${
    input.last_closed_side
      ? ` · pēdējais ${input.last_closed_side}${input.last_close_was_loss ? ' Soft' : ''}`
      : ''
  }`;

  // Structured exceptions — human would fade a failed break
  if (regime === 'FAILED_BREAKOUT_DOWN' || regime === 'REVERSAL_CANDIDATE') {
    if (allow !== 'SELL' || chapter === 'BOUNCE_IN_SELL') {
      /* keep reading below for SELL bias */
    }
  }

  let choice: EntryChoice = 'WAIT';
  let thesis: string;
  let why: string;
  let confidence = 0.55;

  const sellPressure = r > g + 1 || allow === 'SELL' || chapter.includes('SELL');
  const buyPressure = g > r + 1 || allow === 'BUY' || chapter.includes('RALLY');

  // Live regime is fresher than lagging 30m story — choose with the classifier
  // (still refuse knife bounce / dip-in-rally against the live side).
  if (
    (regime === 'TREND_UP' ||
      regime === 'BREAKOUT_UP' ||
      regime === 'PULLBACK_UPTREND') &&
    chapter !== 'BOUNCE_IN_SELL'
  ) {
    choice = 'BUY';
    thesis = `Regime ${regime} — strādāju ar garo pusi (live classifer, ne tikai vecais 30m).`;
    why = 'Izvēle no live regime + stāsta; gaidu BUY setup.';
    confidence = 0.72;
  } else if (
    (regime === 'TREND_DOWN' ||
      regime === 'BREAKOUT_DOWN' ||
      regime === 'PULLBACK_DOWNTREND') &&
    chapter !== 'DIP_IN_RALLY'
  ) {
    choice = 'SELL';
    thesis = `Regime ${regime} — strādāju ar īso pusi.`;
    why = 'Izvēle no live regime + stāsta; gaidu SELL setup.';
    confidence = 0.72;
  } else if (regime === 'FAILED_BREAKOUT_UP') {
    choice = 'SELL';
    thesis = 'FAILED_BREAKOUT_UP — izvēlos SELL fade.';
    why = 'Struktūra saka: neveiksmīgs break uz augšu → short.';
    confidence = 0.7;
  } else if (regime === 'FAILED_BREAKOUT_DOWN') {
    choice = 'BUY';
    thesis = 'FAILED_BREAKOUT_DOWN — izvēlos BUY fade.';
    why = 'Struktūra saka: neveiksmīgs break uz leju → long.';
    confidence = 0.7;
  } else if (chapter === 'BOUNCE_IN_SELL' || (allow === 'SELL' && chapter === 'SELLOFF')) {
    choice = 'SELL';
    thesis = `30m ir selloff (${chapter}) — esmu pārdevēja pusē, ne medīju bounce long.`;
    why =
      body < 0
        ? 'Sarkans 10s apstiprina — ņemu SELL kad setup sakrīt.'
        : 'Gaidu SELL trigger (rally fade / turpinājums), nevis BUY pret stāstu.';
    confidence = Math.max(0.7, conf);
  } else if (chapter === 'DIP_IN_RALLY' || (allow === 'BUY' && chapter === 'RALLY')) {
    choice = 'BUY';
    thesis = `30m ir rally (${chapter}) — pircēja puse, ne shortoju dip.`;
    why =
      body > 0
        ? 'Zaļš 10s apstiprina — ņemu BUY kad setup sakrīt.'
        : 'Gaidu BUY trigger (dip pullback), nevis SELL pret stāstu.';
    confidence = Math.max(0.7, conf);
  } else if (allow === 'SELL' && conf >= 0.55) {
    choice = 'SELL';
    thesis = `Stāsts atļauj SELL (${chapter}) — izvēlos īso pusi.`;
    why = 'Strādāju ar stāstu: meklēju SELL setup, ne aklu RANGE dip BUY.';
    confidence = conf;
  } else if (allow === 'BUY' && conf >= 0.55) {
    choice = 'BUY';
    thesis = `Stāsts atļauj BUY (${chapter}) — izvēlos garo pusi.`;
    why = 'Strādāju ar stāstu: meklēju BUY setup.';
    confidence = conf;
  } else if (allow === 'BOTH' || chapter === 'BREAK_UP' || chapter === 'BREAK_DOWN') {
    if (chapter === 'BREAK_DOWN' || (sellPressure && !buyPressure)) {
      choice = 'SELL';
      thesis = `Break/abpusējs attēls, bet spiediens uz leju — izvēlos SELL.`;
    } else if (chapter === 'BREAK_UP' || (buyPressure && !sellPressure)) {
      choice = 'BUY';
      thesis = `Break/abpusējs attēls, bet spiediens uz augšu — izvēlos BUY.`;
    } else {
      choice = 'WAIT';
      thesis = `Abas puses iespējamas (${chapter}) — nav skaidras izvēles.`;
    }
    why =
      choice === 'WAIT'
        ? 'Gaidu skaidrāku 10s/1m apstiprinājumu pirms entry.'
        : `Izvēle ${choice} no pressure G${g}/R${r} + nodaļas.`;
    confidence = choice === 'WAIT' ? 0.45 : Math.max(0.6, conf);
  } else if (
    input.last_close_was_loss &&
    input.last_closed_side === 'BUY' &&
    sellPressure
  ) {
    choice = 'SELL';
    thesis = `Tikko Soft/manual BUY zaudējums un tirgus joprojām uz leju — izvēlos SELL, ne atkal to pašu BUY.`;
    why = 'Mācos no pēdējā close + live stāsta: otra puse, ne same-dir spam.';
    confidence = 0.75;
  } else if (
    input.last_close_was_loss &&
    input.last_closed_side === 'SELL' &&
    buyPressure
  ) {
    choice = 'BUY';
    thesis = `Tikko Soft/manual SELL zaudējums un tirgus uz augšu — izvēlos BUY.`;
    why = 'Mācos no pēdējā close + live stāsta.';
    confidence = 0.75;
  } else if (chapter === 'RANGE_CHOP' || allow === 'NONE' || conf < 0.5) {
    choice = 'WAIT';
    thesis = `Chop / vājš stāsts (${chapter}, conf=${conf.toFixed(2)}) — nav ko uzspiest.`;
    why = 'Cilvēks teiktu: sēžu malā, kamēr parādās skaidra puse.';
    confidence = 0.4;
  } else {
    choice = 'WAIT';
    thesis = 'Nav pietiekami skaidra attēla entryi.';
    why = 'Gaidu — labāk nekā akls fade.';
    confidence = 0.35;
  }

  const spoken = `PRĀTS ENTRY ${choice} · ${thesis.slice(0, 100)}${
    thesis.length > 100 ? '…' : ''
  } · ${why.slice(0, 80)}${why.length > 80 ? '…' : ''}`;

  return { choice, situation, thesis, why, spoken, confidence };
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
