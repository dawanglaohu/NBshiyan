import {
  StatsSourceDTOSchema,
  type StatsCoverage,
  type StatsSource,
  type StatsSourceDTO,
} from '../../contracts/ops';

type SourceContext = Pick<StatsSourceDTO, 'timezone' | 'timezoneRevision' | 'queriedAt'>;
type SourceReading = {
  value?: number | null;
  coverage?: StatsCoverage;
  dataThrough?: Date | null;
  lastSucceededAt?: Date | null;
  loadDurationSamples?: number;
  stale?: boolean;
  unavailableState?: 'not_connected' | 'query_failed';
};

export function toStatsSourceDTO(
  context: SourceContext,
  source: StatsSource,
  reading: SourceReading = {},
): StatsSourceDTO {
  const missing: StatsSourceDTO = {
    ...context,
    source,
    state: 'query_failed',
    value: null,
    dataThrough: null,
    lastSucceededAt: null,
    coverage: 'unavailable',
    ...(source === 'mean_load_duration_ms' ? { loadDurationSamples: 0 } : {}),
  };

  const value = reading.value ?? null;
  const state = reading.unavailableState ?? (value === null ? 'no_data'
    : reading.stale ? 'stale' : value === 0 ? 'zero' : 'ok');
  const result = StatsSourceDTOSchema.safeParse({
    ...missing,
    state,
    value,
    coverage: reading.coverage ?? 'unavailable',
    dataThrough: reading.dataThrough?.toISOString() ?? null,
    lastSucceededAt: reading.lastSucceededAt?.toISOString() ?? null,
    ...(source === 'mean_load_duration_ms' ? { loadDurationSamples: reading.loadDurationSamples ?? 0 } : {}),
  });
  return result.success ? result.data : missing;
}
