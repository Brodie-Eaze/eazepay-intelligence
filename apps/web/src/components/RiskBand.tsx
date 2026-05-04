'use client';

const TONE: Record<string, string> = {
  PRIME: 'pill-success',
  NEAR_PRIME: 'pill-info',
  SUBPRIME: 'pill-warn',
  DEEP_SUBPRIME: 'pill-danger',
  UNSCORED: 'pill-muted',
};

const LABEL: Record<string, string> = {
  PRIME: 'Prime',
  NEAR_PRIME: 'Near-prime',
  SUBPRIME: 'Subprime',
  DEEP_SUBPRIME: 'Deep subprime',
  UNSCORED: 'Unscored',
};

export function bandFromScore(score: number | null | undefined): string {
  if (score == null) return 'UNSCORED';
  if (score >= 720) return 'PRIME';
  if (score >= 660) return 'NEAR_PRIME';
  if (score >= 580) return 'SUBPRIME';
  return 'DEEP_SUBPRIME';
}

export function RiskBand({ band, score }: { band?: string; score?: number | null }): JSX.Element {
  const b = band ?? bandFromScore(score);
  return <span className={`pill ${TONE[b] ?? 'pill-muted'}`}>{LABEL[b] ?? b}</span>;
}
