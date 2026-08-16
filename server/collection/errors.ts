export class WorkerStoppedError extends Error {
  constructor() {
    super("Collection worker is stopping.");
    this.name = "WorkerStoppedError";
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("Collection worker lease was lost.");
    this.name = "LeaseLostError";
  }
}

export function isCollectionCancellation(error: unknown, signal: AbortSignal) {
  return signal.aborted || error instanceof WorkerStoppedError || error instanceof LeaseLostError;
}
