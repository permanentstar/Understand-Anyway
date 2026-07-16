import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  NightlyFailure,
  NightlyReport,
  NotifyOptions,
  NotifyProvider,
  NotifyProviderFactory,
  NotifyResult,
} from "@understand-anyway/plugin-api";

const execFile = promisify(nodeExecFile);

export interface LarkImNotifyConfig {
  recipient?: string;
  recipientEnv?: string;
  recipientType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  command?: string;
  baseArgs?: string[];
}

export interface LarkImNotifyDeps {
  run?: (command: string, args: string[]) => Promise<void>;
}

function renderFailures(failed: NightlyFailure[]): string {
  if (failed.length === 0) return "无";
  return failed.slice(0, 8).map((item) => `- ${item.project}: ${item.reason}`).join("\n");
}

function buildCard(report: NightlyReport): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Understand-Anyway Nightly · ${report.overallStatus}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**Run**: ${report.runId}`,
            `**Generated**: ${report.generatedAt}`,
            `**Totals**: success=${report.totals.success} skipped=${report.totals.skipped} failed=${report.totals.failed}`,
          ].join("\n"),
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**Success**\n${report.success.join("\n") || "无"}`,
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**Skipped**\n${report.skipped.join("\n") || "无"}`,
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**Failed**\n${renderFailures(report.failed)}`,
        },
      },
    ],
  };
}

function resolveRecipient(config: LarkImNotifyConfig, env: NodeJS.ProcessEnv): string {
  return String(
    config.recipient
    || env[config.recipientEnv || "UA_NIGHTLY_NOTIFY_RECIPIENT"]
    || "",
  ).trim();
}

async function defaultRun(command: string, args: string[]): Promise<void> {
  await execFile(command, args, { env: process.env });
}

export class LarkImNotifyProvider implements NotifyProvider {
  readonly name = "lark-im-notify";

  private readonly recipient: string;
  private readonly recipientType: NonNullable<LarkImNotifyConfig["recipientType"]>;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly run: (command: string, args: string[]) => Promise<void>;

  constructor(config: LarkImNotifyConfig = {}, deps: LarkImNotifyDeps = {}) {
    this.recipient = resolveRecipient(config, process.env);
    this.recipientType = config.recipientType ?? "open_id";
    this.command = config.command ?? "lark-cli";
    this.baseArgs = config.baseArgs ?? ["im", "send"];
    this.run = deps.run ?? defaultRun;
  }

  async sendNightlySummary(report: NightlyReport, options: NotifyOptions = {}): Promise<NotifyResult> {
    if (!this.recipient) {
      return {
        delivered: false,
        skipped: true,
        error: "missing notify recipient (UA_NIGHTLY_NOTIFY_RECIPIENT)",
      };
    }

    const card = buildCard(report);
    const args = [
      ...this.baseArgs,
      "--receive-id-type",
      this.recipientType,
      "--receive-id",
      this.recipient,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(card),
    ];

    if (options.dryRun) {
      return {
        delivered: false,
        skipped: true,
        target: `${this.recipientType}:${this.recipient}`,
      };
    }

    await this.run(this.command, args);
    return {
      delivered: true,
      target: `${this.recipientType}:${this.recipient}`,
    };
  }
}

export const createNotifyProvider: NotifyProviderFactory = (config: unknown) =>
  new LarkImNotifyProvider((config ?? {}) as LarkImNotifyConfig);
