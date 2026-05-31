import { describe, expect, it } from 'vitest';
import { getColor, getLabel, getPill, listOptions, toneToPillClass } from './taxonomy';

/**
 * Taxonomy is the single source of truth for status/tag labels + tones across
 * every list and detail surface. A regression here mis-labels webhooks,
 * exports, alerts, applications — i.e. operator-facing state at large.
 *
 * Tests assert: canonical mapping, case-insensitivity, alias collapse
 * (Active/Live/Enabled/On → one label), unknown-value fallback (never throws),
 * and de-duped option lists for filter dropdowns.
 */

describe('getLabel', () => {
  it('returns the canonical label for a known application status', () => {
    expect(getLabel('application', 'APPROVED')).toBe('Approved');
    expect(getLabel('application', 'IN_REVIEW')).toBe('In review');
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(getLabel('application', 'approved')).toBe('Approved');
    expect(getLabel('application', '  Approved  ')).toBe('Approved');
  });

  it('collapses Active / Live / Enabled / On to one canonical label', () => {
    for (const v of ['active', 'LIVE', 'enabled', 'on', true]) {
      expect(getLabel('genericActive', v)).toBe('Active');
    }
    for (const v of ['inactive', 'DISABLED', 'off', false]) {
      expect(getLabel('genericActive', v)).toBe('Inactive');
    }
  });

  it('translates wire-level export statuses to the canonical UI vocabulary', () => {
    expect(getLabel('export', 'PENDING')).toBe('Queued');
    expect(getLabel('export', 'RUNNING')).toBe('Processing');
    expect(getLabel('export', 'COMPLETED')).toBe('Ready');
    expect(getLabel('export', 'EXPIRED')).toBe('Expired');
  });

  it('translates wire-level webhook statuses to delivered/retrying/failed', () => {
    expect(getLabel('webhook', 'RECEIVED')).toBe('Delivered');
    expect(getLabel('webhook', 'PROCESSED')).toBe('Delivered');
    expect(getLabel('webhook', 'REPLAYED')).toBe('Retrying');
    expect(getLabel('webhook', 'FAILED')).toBe('Failed');
  });

  it('falls back to a title-cased version of unknown values (never throws)', () => {
    expect(getLabel('application', 'BRAND_NEW_STATE')).toBe('Brand New State');
  });

  it('returns em-dash for empty / null / undefined', () => {
    expect(getLabel('application', null)).toBe('—');
    expect(getLabel('application', undefined)).toBe('—');
    expect(getLabel('application', '')).toBe('—');
  });
});

describe('getColor', () => {
  it('maps known values to an Eaze tone token', () => {
    expect(getColor('application', 'APPROVED')).toBe('success');
    expect(getColor('application', 'DECLINED')).toBe('danger');
    expect(getColor('webhook', 'REPLAYED')).toBe('warn');
  });

  it('returns muted for unknown values rather than throwing', () => {
    expect(getColor('application', 'WHO_KNOWS')).toBe('muted');
    expect(getColor('application', null)).toBe('muted');
  });
});

describe('getPill', () => {
  it('returns a ready-to-render label + className pair', () => {
    const pill = getPill('alertSeverity', 'CRITICAL');
    expect(pill.label).toBe('Critical');
    expect(pill.className).toBe('pill pill-danger');
  });
});

describe('toneToPillClass', () => {
  it('formats the tone into the Eaze class string', () => {
    expect(toneToPillClass('success')).toBe('pill pill-success');
    expect(toneToPillClass('muted')).toBe('pill pill-muted');
  });
});

describe('listOptions', () => {
  it('returns a stable, label-sorted, de-duped option list', () => {
    const opts = listOptions('export');
    const labels = opts.map((o) => o.label);
    // Sorted by label
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    // De-duped: PENDING + QUEUED both map to "Queued" — appears once
    const queued = labels.filter((l) => l === 'Queued');
    expect(queued).toHaveLength(1);
  });

  it('returns non-empty lists for every primary domain', () => {
    for (const d of [
      'application',
      'lenderTier',
      'riskBand',
      'customer',
      'export',
      'webhook',
      'alertState',
      'alertSeverity',
      'revenueStream',
      'revenueEventType',
      'funding',
      'activityKind',
      'genericActive',
    ] as const) {
      expect(listOptions(d).length).toBeGreaterThan(0);
    }
  });
});
