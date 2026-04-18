function portalTz() {
  return process.env.PORTAL_TZ || 'Africa/Lagos';
}

/**
 * @param {Array<{ min_hours: number, discount_percent: number|string, label?: string, id?: string, active?: boolean }>} tiers
 * @param {number} durationHours
 */
function pickDiscountTier(tiers, durationHours) {
  const dh = Number(durationHours) || 0;
  const qual = (tiers || []).filter(
    (t) => t && t.active !== false && (Number(t.min_hours) || 0) <= dh + 1e-9
  );
  if (!qual.length) return null;
  return qual.reduce((best, t) => {
    if (!best) return t;
    const pct = Number(t.discount_percent) || 0;
    const bestPct = Number(best.discount_percent) || 0;
    if (pct > bestPct) return t;
    if (pct === bestPct && (Number(t.min_hours) || 0) > (Number(best.min_hours) || 0)) return t;
    return best;
  }, null);
}

/**
 * @param {{ hourly_rate_cents: number|string, durationMinutes: number, full_day_rate_cents?: number|string }} roomInput
 * @param tiers rows from room_discount_tiers
 * @param {{ fullDay?: boolean }} [options]
 */
function computeRoomQuote(roomInput, tiers, options) {
  const dm = Math.max(1, Math.floor(Number(roomInput.durationMinutes) || 0));
  const durationHours = dm / 60;
  const hourly = Number(roomInput.hourly_rate_cents) || 0;
  const fullDay = Number(roomInput.full_day_rate_cents) || 0;
  const opt = options || {};
  const useFullDay =
    Boolean(opt.fullDay) || (hourly <= 0 && fullDay > 0);
  let base;
  if (useFullDay && fullDay > 0) {
    base = Math.round(fullDay);
  } else {
    base = Math.round((hourly * dm) / 60);
  }
  const tier = pickDiscountTier(tiers, durationHours);
  const pct = tier ? Number(tier.discount_percent) || 0 : 0;
  const discount = Math.round((base * pct) / 100);
  const total = Math.max(0, base - discount);
  return {
    durationMinutes: dm,
    durationHours,
    base_cents: base,
    discount_cents: discount,
    total_cents: total,
    discount_tier_id: tier ? tier.id : null,
    discount_tier_label: tier ? tier.label || `${pct}% discount` : null,
    discount_percent: pct,
    full_day: useFullDay,
  };
}

module.exports = { portalTz, pickDiscountTier, computeRoomQuote };
