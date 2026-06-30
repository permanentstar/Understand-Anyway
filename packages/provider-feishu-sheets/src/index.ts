/**
 * @understand-anyway/provider-feishu-sheets
 *
 * Optional Feishu (Lark) Sheets record sink. Implements the open-source
 * {@link RecordProvider} contract over the public Feishu endpoints. Column
 * layout is config-driven (per record kind), so it is not bound to any
 * particular event schema.
 */

export {
  FeishuSheetsRecordProvider,
  type FeishuSheetsRecordProviderOptions,
  type SheetKindMapping,
} from "./feishu-sheets-record-provider.js";
export {
  FeishuSheetsClient,
  columnLetter,
  type FeishuSheetsClientOptions,
  type FetchLike,
} from "./feishu-sheets-client.js";
