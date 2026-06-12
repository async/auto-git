#!/usr/bin/env node
import { beginShutdown, runPipelineCli, shutdownExitCode } from "@async/pipeline/node";

const shutdownOnEpipe = (error) => {
  if (error?.code === "EPIPE") {
    beginShutdown("SIGTERM", 141);
    return;
  }
  throw error;
};

process.stdout.on("error", shutdownOnEpipe);
process.stderr.on("error", shutdownOnEpipe);

try {
  const result = await runPipelineCli({ args: process.argv.slice(2) });
  process.exitCode = shutdownExitCode() ?? result.code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = shutdownExitCode() ?? 1;
}
