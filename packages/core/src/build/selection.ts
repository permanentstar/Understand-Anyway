import { isAbsolute, relative } from "node:path";

interface BatchFile {
  path: string;
}

interface Batch {
  batchIndex: number | string;
  files?: BatchFile[];
}

export function normalizeIncludePaths(paths: string[], projectRoot: string): string[] {
  return [
    ...new Set(
      paths
        .map((p) => (isAbsolute(p) ? relative(projectRoot, p) : p))
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => p.length > 0 && !p.startsWith("..")),
    ),
  ];
}

export function parseChangedFiles(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

export function selectBatchesForFiles<T extends Batch>(batches: T[], files: string[]): T[] {
  const wanted = new Set(files);
  return batches.filter((batch) => (batch.files ?? []).some((file) => wanted.has(file.path)));
}
