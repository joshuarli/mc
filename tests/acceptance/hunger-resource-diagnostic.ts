import type { stageOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import type { RunPreparedRunOptions } from "../../packages/arena-runner/src/runtime/run.js";
import type { ResourceMonitorSampleEvent } from "../../packages/arena-runner/src/runtime/resource-monitor.js";

const MAX_FAILURE_BYTES = 16 * 1024;
const MAX_FAILURE_COMMANDS = 2;
const DIAGNOSTIC_STAGE_TIMEOUT_MS = 10_000;

type FailureCapture =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "captured"; contents: Buffer }>
  | Readonly<{ status: "failed"; error: unknown }>;

/** Retains one exact failed sample until runtime cleanup settles, including failures before evaluation. */
export async function withHungerResourceDiagnostic<T>(
  context: Readonly<{
    helperPath: string;
    ownedRoot: Buffer;
    preparedRun: Pick<RunPreparedRunOptions["preparedRun"], "runId" | "runDirectoryPath">;
    seed: bigint;
  }>,
  execute: (onSample: (event: ResourceMonitorSampleEvent) => void) => Promise<T>,
  stage: (request: Parameters<typeof stageOwnedFile>[0]) => Promise<unknown>,
): Promise<T> {
  const capture: { value: FailureCapture } = { value: { status: "absent" } };
  const onSample = (event: ResourceMonitorSampleEvent): void => {
    if (event.status !== "failed" || capture.value.status !== "absent") return;
    try {
      if (event.timing.commands.length > MAX_FAILURE_COMMANDS) {
        throw new RangeError("failed resource sample exceeds the command count limit");
      }
      const contents = Buffer.from(`${JSON.stringify({
        schema: 1,
        run_id: context.preparedRun.runId,
        seed: context.seed.toString(),
        event: {
          status: event.status,
          source: { category: event.source.category, resource: event.source.resource, source: event.source.source },
          timing: event.timing,
        },
      }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`, "utf8");
      if (contents.length > MAX_FAILURE_BYTES) {
        throw new RangeError("failed resource sample exceeds the diagnostic byte limit");
      }
      capture.value = { status: "captured", contents };
    } catch (error) {
      // Callback failure would replace the initiating monitoring error, so report it after cleanup.
      capture.value = { status: "failed", error };
    }
  };

  try {
    return await execute(onSample);
  } catch (initiatingError) {
    try {
      if (capture.value.status === "failed") throw capture.value.error;
      if (capture.value.status === "captured") {
        // The run signal may already be cancelled; staging owns a separate deadline and helper cleanup.
        const controller = new AbortController();
        const deadline = setTimeout(() => {
          controller.abort(new DOMException("hunger resource diagnostic staging timed out", "TimeoutError"));
        }, DIAGNOSTIC_STAGE_TIMEOUT_MS);
        try {
          await stage({
            helperPath: context.helperPath,
            ownedRoot: context.ownedRoot,
            relativePath: Buffer.concat([
              context.preparedRun.runDirectoryPath,
              Buffer.from("/hunger-resource-failure-v1.json", "ascii"),
            ]),
            contents: capture.value.contents,
            maxBytes: MAX_FAILURE_BYTES,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(deadline);
        }
      }
    } catch (diagnosticError) {
      throw new AggregateError([initiatingError, diagnosticError], "hunger run and resource diagnostic failed", {
        cause: initiatingError,
      });
    }
    throw initiatingError;
  }
}
