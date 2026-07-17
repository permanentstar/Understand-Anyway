/**
 * @understand-anyway/provider-feishu-sheets
 *
 * Optional Feishu (Lark) Sheets record sink. Implements the open-source
 * {@link RecordProvider} contract over the public Feishu endpoints. Standard
 * Understand-Anyway record headers are built in; deployments can override
 * worksheet titles or provide custom mappings for non-standard record kinds.
 */

export {
  FeishuSheetsRecordProvider,
  NIGHTLY_UPDATE_COLUMNS,
  PROJECT_UPDATE_COLUMNS,
  USER_EVENT_COLUMNS,
  type FeishuSheetsRecordProviderOptions,
  type SheetKindMapping,
} from "./feishu-sheets-record-provider.js";
export {
  FeishuSheetsClient,
  columnLetter,
  type FeishuSheetsClientOptions,
  type FetchLike,
} from "./feishu-sheets-client.js";
