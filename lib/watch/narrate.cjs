'use strict';

const { describePath, formatDelta, formatDuration, formatValue } = require('./format.cjs');
const rules = require('./rules.cjs');

/**
 * Finding text, from templates.
 *
 * Deliberately not a language model. Every number below is one the detector
 * measured, rendered in the operator's units, so the text cannot drift from
 * the data and needs no verification - and it costs nothing to produce, on a
 * board where the GPU belongs to the operator's own questions. The AI is asked
 * about an incident only when the operator chooses to (the panel's "Ask AI"
 * button), never in the background.
 */

const GNSS_TITLES = {
  jump: 'GNSS position jumped',
  deadReckoning: 'GNSS fix disagrees with dead reckoning',
  sourcesDisagree: 'GNSS receivers disagree',
  quality: 'GNSS fix quality dropped',
  frozen: 'GNSS fix stopped moving',
  clock: 'GNSS clock jumped'
};

function displayValue(value) {
  if (value === 'true' || value === true) return 'on (true)';
  if (value === 'false' || value === false) return 'off (false)';
  return `"${value}"`;
}

function narrate(detector, info, evidence = {}, cond = {}) {
  const path = info && info.path;
  const units = info && info.units;
  const name = describePath(path, info && info.displayName);

  switch (detector) {
    case 'shift': {
      const high = evidence.z > 0;
      const slope =
        typeof evidence.slopePerMinute === 'number' && Math.abs(evidence.slopePerMinute) > 0
          ? `, changing ${formatDelta(path, evidence.slopePerMinute, units)}/min`
          : '';
      return {
        title: `${name} unusually ${high ? 'high' : 'low'}`,
        message:
          `${formatValue(path, evidence.value, units)}, ${formatDelta(path, evidence.delta, units)} from its usual ` +
          `${formatValue(path, evidence.baseline, units)} (${Math.abs(evidence.z).toFixed(1)}× its normal variation)${slope}`
      };
    }
    case 'dropout':
      return {
        title: `${name} stopped updating`,
        message:
          `No update for ${formatDuration(evidence.silentFor)}; it normally updates every ` +
          `${formatDuration(evidence.intervalMean)}${evidence.source ? ` (source ${evidence.source})` : ''}`
      };
    case 'frozen':
      return {
        title: `${name} looks stuck`,
        message:
          `Repeating exactly ${formatValue(path, evidence.value, units)} for ${formatDuration(evidence.frozenFor)} ` +
          `(${evidence.repeats} updates); it normally changes on most updates`
      };
    case 'newState': {
      const known = Array.isArray(evidence.known) && evidence.known.length > 0
        ? ` (seen before: ${evidence.known.slice(0, 5).map(displayValue).join(', ')})`
        : '';
      return {
        title: `${name} changed to ${displayValue(evidence.value)}`,
        message: `A value this path has not taken before${known}`
      };
    }
    case 'cycling':
      return {
        title: `${name} switching unusually often`,
        message:
          `${evidence.lastHour} changes in the last hour, against about ` +
          `${Number(evidence.baselinePerHour || 0).toFixed(1)} per hour normally`
      };
    case 'forecast': {
      const limit = evidence.label ? `${evidence.zone} limit (${evidence.label})` : `${evidence.zone} zone (${formatValue(path, evidence.limit, units)})`;
      return {
        title: `${name} heading for its ${evidence.zone === 'low' ? 'limit' : `${evidence.zone} zone`}`,
        message:
          `${formatValue(path, evidence.value, units)} now, changing ${formatDelta(path, evidence.slopePerMinute, units)}/min: ` +
          `reaches the ${limit} in about ${formatDuration(evidence.etaMs)} if the trend holds`
      };
    }
    case 'disagree': {
      const gap = formatDelta(path, Math.abs(evidence.diff), units, { signed: false });
      const usual = formatDelta(path, evidence.usualGap || 0, units, { signed: false });
      return {
        title: `${name}: sources disagree`,
        message:
          `${evidence.primary} reads ${formatValue(path, evidence.primaryValue, units)}, ${evidence.source} reads ` +
          `${formatValue(path, evidence.value, units)}: ${gap} apart, where they are usually within ${usual}`
      };
    }
    case 'failover':
      return {
        title: `${name} switched source`,
        message: `${evidence.from} went quiet; now reading ${evidence.to}`
      };
    case 'rule': {
      const rule = evidence.rule;
      if (!rule) return { title: 'Watch rule', message: '' };
      const infoFor = (info && info.infoFor) || (() => undefined);
      const now = rules.describeValue(rule.path, evidence.value, infoFor(rule.path) || { units });
      const changed = rule.op === 'changes' && evidence.from !== undefined
        ? `Changed from ${rules.describeValue(rule.path, evidence.from, infoFor(rule.path) || { units })} to ${now}`
        : `Now ${now}`;
      return {
        title: rules.describeRule(rule, infoFor).replace(/^(?:Warn|Alert) when /, ''),
        message: `${changed}. Your watch: "${rule.text || rules.describeRule(rule, infoFor)}"`
      };
    }
    case 'feed':
      return {
        title: 'Signal K data stopped arriving',
        message:
          `${evidence.silent} of ${evidence.regular} regularly updating paths have gone quiet` +
          (Array.isArray(evidence.sources) && evidence.sources.length > 0 ? ` (sources: ${evidence.sources.slice(0, 5).join(', ')})` : '')
      };
    default:
      if (detector && detector.startsWith('gnss.')) {
        const indicator = detector.slice(5);
        return { title: GNSS_TITLES[indicator] || 'GNSS integrity', message: cond.message || '' };
      }
      return { title: `${name}: ${detector}`, message: cond.message || '' };
  }
}

module.exports = { narrate };
