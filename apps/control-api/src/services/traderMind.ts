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
import { readMultiTfStack, sideFromMultiTf, type TfDir } from './multiTfRead.js';

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
  /** Live Capital / book 1m — what the human sees on the chart */
  m1_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  m1_strong?: boolean;
  /** Multi-1m trek bias */
  bias?: 'UP' | 'DOWN' | 'FLAT' | null;
  /** Higher timeframes — easier to read the market (5m / 15m / 30m) */
  tf5_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  tf15_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  tf30_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
};

/**
 * Entry mind — chooses BUY / SELL / WAIT from the live picture.
 *
 * Order of thought (human at Capital):
 *  1) Read the stack top-down: 30m → 15m → 5m → 1m
 *  2) Does the 30m story / regime agree with that stack?
 *  3) Pick a side — or WAIT when higher TFs fight or 1m knives the bias
 *
 * Not a block list and not a regime→side dictionary. The stack leads.
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
  const m1 = (input.m1_dir || 'FLAT').toUpperCase() as TfDir;
  const bias = (input.bias || 'FLAT').toUpperCase() as TfDir;
  const strong = Boolean(input.m1_strong);
  const tf5 = (input.tf5_dir || 'FLAT').toUpperCase() as TfDir;
  const tf15 = (input.tf15_dir || 'FLAT').toUpperCase() as TfDir;
  const tf30 = (input.tf30_dir || 'FLAT').toUpperCase() as TfDir;
  const storyLine = input.story_summary || `STĀSTS · ${chapter}`;

  // Trigger tape: Capital 1m preferred; trek bias fills when 1m is FLAT
  const tf1: TfDir = m1 !== 'FLAT' ? m1 : bias !== 'FLAT' ? bias : 'FLAT';

  const stack = readMultiTfStack({ tf30, tf15, tf5, tf1 });
  const stackSide = sideFromMultiTf(stack);

  const situation = `Flat · ${stack.summary} · 1m ${m1}${strong ? ' (spēcīga)' : ''} · bias ${bias} · regime ${regime} · ${storyLine} · allow ${allow} · G${g}/R${r} · zona ${
    pos != null && Number.isFinite(pos) ? pos.toFixed(2) : '—'
  } · 10s ${body > 0 ? 'zaļš' : body < 0 ? 'sarkans' : 'kluss'}${
    input.last_closed_side
      ? ` · pēdējais ${input.last_closed_side}${input.last_close_was_loss ? ' Soft' : ''}`
      : ''
  }`;

  let choice: EntryChoice = 'WAIT';
  let thesis: string;
  let why: string;
  let confidence = 0.5;

  const buyStory =
    allow === 'BUY' ||
    chapter === 'RALLY' ||
    chapter === 'DIP_IN_RALLY' ||
    chapter === 'BREAK_UP' ||
    g > r + 1;
  const sellStory =
    allow === 'SELL' ||
    chapter === 'SELLOFF' ||
    chapter === 'BOUNCE_IN_SELL' ||
    chapter === 'BREAK_DOWN' ||
    r > g + 1;
  const regimeLong =
    regime === 'TREND_UP' ||
    regime === 'BREAKOUT_UP' ||
    regime === 'PULLBACK_UPTREND' ||
    regime === 'FAILED_BREAKOUT_DOWN';
  const regimeShort =
    regime === 'TREND_DOWN' ||
    regime === 'BREAKOUT_DOWN' ||
    regime === 'PULLBACK_DOWNTREND' ||
    regime === 'FAILED_BREAKOUT_UP';

  // ——— 1) Multi-TF stack first (30m → 15m → 5m → 1m) ———
  if (stackSide === 'WAIT' && stack.bias !== 'FLAT') {
    // Higher bias clear but mid/trigger fighting — never invent the opposite side
    choice = 'WAIT';
    thesis = stack.thesis_lv;
    why = 'Cilvēks nespiestu pusi, kamēr 30/15/5/1m nesakrīt.';
    confidence = 0.4;
  } else if (stackSide === 'BUY') {
    if (sellStory && !buyStory && !regimeLong && m1 !== 'UP' && stack.tf5 !== 'UP') {
      choice = 'WAIT';
      thesis = `Steks ${stack.summary} UP, bet stāsts vēl ${chapter} — gaidu, ne shortoju.`;
      why = 'Pretējs stāsts + augšup steks: labāk WAIT nekā naža SELL.';
      confidence = 0.55;
    } else if (chapter === 'BOUNCE_IN_SELL' && m1 !== 'UP' && stack.tf5 !== 'UP') {
      choice = 'WAIT';
      thesis = 'Bounce selloff bez skaidras 5m/1m UP — nepalieku long pret selloff.';
      why = 'Gaidu, kamēr zemākie TF apstiprina vai selloff atsākas.';
      confidence = 0.5;
    } else {
      choice = 'BUY';
      thesis =
        stack.aligned
          ? `${stack.thesis_lv}`
          : m1 === 'UP'
            ? `1m ir zaļa${strong ? ' un spēcīga' : ''} · ${stack.summary} — strādāju kā pircējs.`
            : `Steks ${stack.summary} — pircēju puse; meklēju BUY, ne SELL fade.`;
      why =
        body > 0
          ? '10s arī zaļš — ņemu BUY kad setup sakrīt ar manu pusi.'
          : 'Gaidu BUY trigger (dip pullback), nevis shortu pret sveci.';
      confidence = stack.aligned
        ? m1 === 'UP' && strong
          ? 0.9
          : 0.82
        : m1 === 'UP' && strong
          ? 0.85
          : bias === 'UP'
            ? 0.75
            : 0.68;
      if (regimeLong || buyStory) confidence = Math.min(0.92, confidence + 0.06);
    }
  } else if (stackSide === 'SELL') {
    if (buyStory && !sellStory && !regimeShort && m1 !== 'DOWN' && stack.tf5 !== 'DOWN') {
      choice = 'WAIT';
      thesis = `Steks ${stack.summary} DOWN, bet stāsts vēl ${chapter} — gaidu, ne medīju bounce long.`;
      why = 'Pretējs stāsts + lejup steks: labāk WAIT nekā naža BUY.';
      confidence = 0.55;
    } else if (chapter === 'DIP_IN_RALLY' && m1 !== 'DOWN' && stack.tf5 !== 'DOWN') {
      choice = 'WAIT';
      thesis = 'Dip rally bez skaidras 5m/1m DOWN — ne shortoju dip.';
      why = 'Gaidu zemāko TF apstiprinājumu.';
      confidence = 0.5;
    } else {
      choice = 'SELL';
      thesis =
        stack.aligned
          ? `${stack.thesis_lv}`
          : m1 === 'DOWN'
            ? `1m ir sarkana${strong ? ' un spēcīga' : ''} · ${stack.summary} — strādāju kā pārdevējs.`
            : `Steks ${stack.summary} — pārdevēju puse; meklēju SELL, ne BUY bounce.`;
      why =
        body < 0
          ? '10s arī sarkans — ņemu SELL kad setup sakrīt.'
          : 'Gaidu SELL trigger (rally fade), nevis long pret sveci.';
      confidence = stack.aligned
        ? m1 === 'DOWN' && strong
          ? 0.9
          : 0.82
        : m1 === 'DOWN' && strong
          ? 0.85
          : bias === 'DOWN'
            ? 0.75
            : 0.68;
      if (regimeShort || sellStory) confidence = Math.min(0.92, confidence + 0.06);
    }
  } else {
    // ——— 2) Flat / mixed stack — use story / regime / pressure (still a choice) ———
    if (regimeLong && chapter !== 'BOUNCE_IN_SELL') {
      choice = 'BUY';
      thesis = `Steks jauktā (${stack.summary}), bet regime ${regime} — turu garo pusi kā darba hipotēzi.`;
      why = 'Bez skaidra multi-TF sekoju live regime; gaidu BUY setup.';
      confidence = 0.62;
    } else if (regimeShort && chapter !== 'DIP_IN_RALLY') {
      choice = 'SELL';
      thesis = `Steks jauktā (${stack.summary}), bet regime ${regime} — turu īso pusi kā darba hipotēzi.`;
      why = 'Bez skaidra multi-TF sekoju live regime; gaidu SELL setup.';
      confidence = 0.62;
    } else if (chapter === 'BOUNCE_IN_SELL' || (allow === 'SELL' && chapter === 'SELLOFF')) {
      choice = 'SELL';
      thesis = `30m selloff (${chapter}) un steks nav UP — esmu pārdevēja pusē.`;
      why = body < 0 ? 'Sarkans 10s apstiprina SELL.' : 'Gaidu SELL trigger.';
      confidence = Math.max(0.65, conf);
    } else if (chapter === 'DIP_IN_RALLY' || (allow === 'BUY' && chapter === 'RALLY')) {
      choice = 'BUY';
      thesis = `30m rally (${chapter}) un steks nav DOWN — esmu pircēja pusē.`;
      why = body > 0 ? 'Zaļš 10s apstiprina BUY.' : 'Gaidu BUY trigger.';
      confidence = Math.max(0.65, conf);
    } else if (allow === 'SELL' && conf >= 0.55 && g <= r) {
      choice = 'SELL';
      thesis = `Stāsts atļauj SELL (${chapter}) · pressure G${g}/R${r} · ${stack.summary}.`;
      why = 'Izvēlos īso pusi no stāsta, kamēr multi-TF nav pretī.';
      confidence = conf;
    } else if (allow === 'BUY' && conf >= 0.55 && r <= g) {
      choice = 'BUY';
      thesis = `Stāsts atļauj BUY (${chapter}) · pressure G${g}/R${r} · ${stack.summary}.`;
      why = 'Izvēlos garo pusi no stāsta, kamēr multi-TF nav pretī.';
      confidence = conf;
    } else if (
      input.last_close_was_loss &&
      input.last_closed_side === 'BUY' &&
      (sellStory || r > g)
    ) {
      choice = 'SELL';
      thesis = 'Pēc Soft BUY zaudējuma un lejup spiediena — otra puse, ne same-dir spam.';
      why = 'Mācos no pēdējā close + live pressure.';
      confidence = 0.7;
    } else if (
      input.last_close_was_loss &&
      input.last_closed_side === 'SELL' &&
      (buyStory || g > r)
    ) {
      choice = 'BUY';
      thesis = 'Pēc Soft SELL zaudējuma un augšup spiediena — otra puse.';
      why = 'Mācos no pēdējā close + live pressure.';
      confidence = 0.7;
    } else if (chapter === 'RANGE_CHOP' || allow === 'NONE' || conf < 0.45) {
      choice = 'WAIT';
      thesis = `Chop / vājš stāsts (${chapter}, conf=${conf.toFixed(2)}) · ${stack.summary} — nav ko uzspiest.`;
      why = 'Cilvēks sēž malā, kamēr parādās skaidra puse.';
      confidence = 0.4;
    } else {
      choice = 'WAIT';
      thesis = `Steks jauktā (${stack.summary}) un nav pietiekami skaidra stāsta — gaidu.`;
      why = 'Labāk WAIT nekā akls RANGE fade.';
      confidence = 0.35;
    }
  }

  // Hard veto: never knife a clear aligned higher-TF impulse on a lone flicker
  if (choice === 'SELL' && stack.bias === 'UP' && (stack.tf30 === 'UP' || stack.tf15 === 'UP')) {
    choice = 'WAIT';
    thesis = `${stack.summary} — augšējie TF UP; ne shortoju.`;
    why = 'Multi-TF veto: SELL pret 30/15m UP nav cilvēka darbs.';
    confidence = 0.35;
  }
  if (choice === 'BUY' && stack.bias === 'DOWN' && (stack.tf30 === 'DOWN' || stack.tf15 === 'DOWN')) {
    choice = 'WAIT';
    thesis = `${stack.summary} — augšējie TF DOWN; ne longoju.`;
    why = 'Multi-TF veto: BUY pret 30/15m DOWN nav cilvēka darbs.';
    confidence = 0.35;
  }

  const spoken = `PRĀTS ENTRY ${choice} · ${stack.summary} · ${thesis.slice(0, 90)}${
    thesis.length > 90 ? '…' : ''
  } · ${why.slice(0, 70)}${why.length > 70 ? '…' : ''}`;

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
