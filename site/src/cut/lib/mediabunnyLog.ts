import { Logging, LogLevel } from "mediabunny";

import { reportSwallowed } from "./report";

/**
 * mediabunny's error log, routed through Cut's failure reporting.
 *
 * mediabunny prints its errors with console.error, which error tracking
 * captures as a bare exception with the sentence dropped — and most of them
 * are failures it already handles: a fetch it retries, a response stream it
 * resumes. Silencing its console and reporting each error with its own words
 * sends the transient ones to console.warn and names the rest. Warnings and
 * info stay off the console, as they were at the default level.
 */
Logging.level = LogLevel.Silent;
Logging.on("error", ([what, err]) => {
  reportSwallowed(`[mediabunny] ${String(what).trim()}`, err);
});
