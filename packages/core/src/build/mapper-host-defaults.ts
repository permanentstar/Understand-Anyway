/**
 * Host-aware defaults for the segmented mapper. Pure functions; cpu/mem
 * sources are injected so tests run on any host. Tiers ported verbatim from
 * deploy `defaultMapperBatchCountForHost / defaultMapperConcurrencyForHost`.
 *
 *   defaultMapperConcurrencyForHost(cpu, memGb):
 *     cpu>=16 && memGb>=64 -> 4
 *     cpu>=8 && memGb>=32  -> 2
 *     default              -> 1
 *
 *   defaultMapperBatchCountForHost(cpu, memGb):
 *     cpu>=16 && memGb>=64 -> 100
 *     default              -> 50
 */

import { cpus, totalmem } from "node:os";

export interface HostMetrics {
  cpuCount: number;
  memoryGb: number;
}

export interface HostMetricsDeps {
  cpus?: () => unknown[];
  totalmem?: () => number;
}

export function readHostMetrics(deps: HostMetricsDeps = {}): HostMetrics {
  const cpuFn = deps.cpus ?? (cpus as unknown as () => unknown[]);
  const memFn = deps.totalmem ?? totalmem;
  const cpuCount = Math.max(1, cpuFn().length);
  const memoryGb = memFn() / 1024 / 1024 / 1024;
  return { cpuCount, memoryGb };
}

export function defaultMapperConcurrencyForHost(metrics: HostMetrics): number {
  if (metrics.cpuCount >= 16 && metrics.memoryGb >= 64) return 4;
  if (metrics.cpuCount >= 8 && metrics.memoryGb >= 32) return 2;
  return 1;
}

export function defaultMapperBatchCountForHost(metrics: HostMetrics): number {
  if (metrics.cpuCount >= 16 && metrics.memoryGb >= 64) return 100;
  return 50;
}
