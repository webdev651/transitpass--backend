'use strict';
const config = require('../config');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const peso = (n) => `₱${n.toFixed(2)}`;

/** The settings used when no database rule applies (the original .env values). Normal operation reads fare_rules instead (services/fares.js). */
const envFare = () => ({ full: config.fare.full, percent: round2(config.fare.discountRate * 100), ruleId: null, routeId: null, source: 'env' });
const pct = (n) => String(round2(Number(n)));   // 20 -> "20", 12.5 -> "12.5"

/** Fare text and amounts for a granted scan. Text formats match the existing frontend. `cfg` = { full, percent, ruleId } from the active rule. */
function grantedFare(discountEligible, cfg = envFare()) {
  const { full, percent } = cfg;
  const withRule = (out) => {
    if (cfg.ruleId != null) out.ruleId = cfg.ruleId;
    return out;
  };
  if (discountEligible && percent > 0) {
    const paid = round2(full * (1 - percent / 100));
    return withRule({ text: `${peso(paid)} (−${pct(percent)}%)`, amount: paid, discount: round2(full - paid) });
  }
  return withRule({ text: `${peso(full)} (full fare — ${discountEligible ? 'no discount is active right now' : 'discount not eligible'})`, amount: full, discount: 0 });
}

/** Denied / review scans are charged the full fare and release no discount. */
function fullFare(cfg = envFare()) {
  const out = { text: 'Full fare', amount: cfg.full, discount: 0 };
  if (cfg.ruleId != null) out.ruleId = cfg.ruleId;
  return out;
}

function discountStatusText(discountEligible, cfg = envFare()) {
  if (!discountEligible) return 'Not eligible — full fare';
  return cfg.percent > 0 ? `Eligible — ${pct(cfg.percent)}% discount` : 'Eligible — no discount is active right now';
}

module.exports = { grantedFare, fullFare, discountStatusText, envFare, round2, peso };
