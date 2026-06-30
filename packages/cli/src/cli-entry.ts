/**
 * Absolute path of the CLI entry. Extracted into its own module so that
 * subcommand dispatchers (e.g. dashboard-prod) can compute the binary path
 * without import'ing back into the main `cli.ts` file (which itself imports
 * subcommand dispatchers — that would create a cycle and would also violate
 * the §D-isolation rule "main pipeline must not import dashboard-prod").
 */

import { fileURLToPath } from "node:url";

export const CLI_ENTRY = fileURLToPath(new URL("./cli.js", import.meta.url));
