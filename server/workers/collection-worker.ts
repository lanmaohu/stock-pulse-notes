import crypto from "node:crypto";
import type { CollectionRun } from "../../shared/types.js";
import { processCreator as defaultProcessCreator } from "../collection/processor.js";
import { LeaseLostError, WorkerStoppedError } from "../collection/errors.js";
import {
  claimNextQueuedCollectionRun,
  finishCollectionRun,
  recoverInterruptedCollectionRuns,
  releaseCollectionRun,
  renewCollectionRunLease
} from "../repositories/collection.js";
import { errorFields, log } from "../observability/logger.js";

const leaseDurationMs = 5 * 60 * 1_000;

function abortableWait(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface CollectionWorkerDependencies {
  claim?: typeof claimNextQueuedCollectionRun;
  renew?: typeof renewCollectionRunLease;
  release?: typeof releaseCollectionRun;
  finish?: typeof finishCollectionRun;
  recover?: typeof recoverInterruptedCollectionRuns;
  processCreator?: typeof defaultProcessCreator;
  pollIntervalMs?: number;
}

export function createCollectionWorker(dependencies: CollectionWorkerDependencies = {}) {
  const claim = dependencies.claim || claimNextQueuedCollectionRun;
  const renew = dependencies.renew || renewCollectionRunLease;
  const release = dependencies.release || releaseCollectionRun;
  const finish = dependencies.finish || finishCollectionRun;
  const recover = dependencies.recover || recoverInterruptedCollectionRuns;
  const processCreator = dependencies.processCreator || defaultProcessCreator;
  const workerId = crypto.randomUUID();
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activePromise: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  let activeRun: CollectionRun | null = null;

  async function processQueue() {
    if (activePromise || stopping) return;
    const operation = (async () => {
      let run = claim(workerId, Date.now() + leaseDurationMs);
      while (run && !stopping) {
        activeRun = run;
        const controller = new AbortController();
        activeController = controller;
        const heartbeat = setInterval(() => {
          if (!renew(run!.id, workerId, Date.now() + leaseDurationMs)) {
            controller.abort(new LeaseLostError());
          }
        }, 30_000);
        heartbeat.unref();
        try {
          for (const item of run.items) {
            if (item.status !== "queued") continue;
            await processCreator(item, {
              leaseOwner: workerId,
              signal: controller.signal,
              contentLimit: run.trigger === "subscription" ? 5 : undefined
            });
            if (run.items.length > 1) await abortableWait(900, controller.signal);
          }
          if (!finish(run.id, undefined, workerId)) throw new LeaseLostError();
        } catch (error) {
          if (controller.signal.aborted) {
            if (controller.signal.reason instanceof WorkerStoppedError) release(run.id, workerId);
          } else if (error instanceof LeaseLostError) {
            // A newer worker owns the run; this worker must not finalize it.
          } else {
            finish(run.id, error instanceof Error ? error.message : "采集任务意外中断。", workerId);
          }
        } finally {
          clearInterval(heartbeat);
          activeController = null;
          activeRun = null;
        }
        if (stopping) break;
        run = claim(workerId, Date.now() + leaseDurationMs);
      }
    })();
    activePromise = operation;
    try {
      await operation;
    } finally {
      activePromise = null;
    }
  }

  function wake() {
    void processQueue().catch((error) => {
      log("error", "collection_worker_failed", errorFields(error));
    });
  }

  function start() {
    stopping = false;
    recover();
    wake();
    timer = setInterval(wake, dependencies.pollIntervalMs ?? 1_000);
    return stop;
  }

  async function stop() {
    if (stopping) return activePromise || Promise.resolve();
    stopping = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    activeController?.abort(new WorkerStoppedError());
    await activePromise;
    if (activeRun) release(activeRun.id, workerId);
  }

  return { start, stop, wake, workerId };
}

const defaultWorker = createCollectionWorker();

export function wakeCollectionWorker() {
  defaultWorker.wake();
}

export function startCollectionWorker() {
  return defaultWorker.start();
}
