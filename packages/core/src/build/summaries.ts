/**
 * Deterministic node/edge descriptive text, ported verbatim from deploy. These
 * power the heuristic (non-LLM) graph and must stay byte-identical so fixture
 * regression baselines hold.
 */

export interface FileAnalysisLike {
  functions?: Array<{ name: string }>;
  classes?: Array<{ name: string }>;
  definitions?: unknown[];
  sections?: unknown[];
}

export function complexityFromLines(lines: number): "simple" | "moderate" | "complex" {
  if (lines <= 120) return "simple";
  if (lines <= 400) return "moderate";
  return "complex";
}

function zhSummary(filePath: string, language: string, analysis: FileAnalysisLike | null): string {
  const fnCount = analysis?.functions?.length || 0;
  const clsCount = analysis?.classes?.length || 0;
  const defCount = analysis?.definitions?.length || 0;
  const sectionCount = analysis?.sections?.length || 0;
  if (fnCount || clsCount) {
    return `${filePath} 是一个 ${language} 源文件，包含 ${fnCount} 个函数和 ${clsCount} 个类。`;
  }
  if (defCount) {
    return `${filePath} 定义了 ${defCount} 个结构化对象。`;
  }
  if (sectionCount) {
    return `${filePath} 是一份文档，包含 ${sectionCount} 个章节。`;
  }
  return `${filePath} 是一个 ${language} 文件。`;
}

function enSummary(filePath: string, language: string, analysis: FileAnalysisLike | null): string {
  const fnCount = analysis?.functions?.length || 0;
  const clsCount = analysis?.classes?.length || 0;
  const defCount = analysis?.definitions?.length || 0;
  const sectionCount = analysis?.sections?.length || 0;
  if (fnCount || clsCount) {
    return `${filePath} is a ${language} source file with ${fnCount} functions and ${clsCount} classes.`;
  }
  if (defCount) {
    return `${filePath} defines ${defCount} structured objects.`;
  }
  if (sectionCount) {
    return `${filePath} is a document with ${sectionCount} sections.`;
  }
  return `${filePath} is a ${language} file.`;
}

export function fileSummary(
  filePath: string,
  language: string,
  analysis: FileAnalysisLike | null,
  outputLanguage: string,
): string {
  return outputLanguage.startsWith("zh")
    ? zhSummary(filePath, language, analysis)
    : enSummary(filePath, language, analysis);
}

export function symbolSummary(
  kind: "function" | "class" | string,
  name: string,
  filePath: string,
  outputLanguage: string,
): string {
  if (outputLanguage.startsWith("zh")) {
    if (kind === "function") return `函数 ${name}，定义于 ${filePath}。`;
    if (kind === "class") return `类 ${name}，定义于 ${filePath}。`;
    return `${name}，定义于 ${filePath}。`;
  }
  if (kind === "function") return `Function ${name} defined in ${filePath}.`;
  if (kind === "class") return `Class ${name} defined in ${filePath}.`;
  return `${name} defined in ${filePath}.`;
}

export function nonCodeType(fileCategory: string): "config" | "resource" | "schema" | "document" {
  switch (fileCategory) {
    case "config":
      return "config";
    case "infra":
      return "resource";
    case "data":
      return "schema";
    case "docs":
    case "markup":
    default:
      return "document";
  }
}

export function buildProjectDescription(
  projectName: string,
  analyzedFiles: number,
  outputLanguage: string,
  incremental = false,
): string {
  if (outputLanguage.startsWith("zh")) {
    return incremental
      ? `${projectName} 的本地知识图谱，基于 ${analyzedFiles} 个文件的增量分析更新。`
      : `${projectName} 的本地知识图谱，基于 ${analyzedFiles} 个文件生成。`;
  }
  return incremental
    ? `Local knowledge graph for ${projectName}, updated incrementally from ${analyzedFiles} files.`
    : `Local knowledge graph for ${projectName}, generated from ${analyzedFiles} files.`;
}
