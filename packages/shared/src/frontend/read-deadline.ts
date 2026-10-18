/** A read deadline covers headers and body; it never retries or changes navigation. */
export class ReadDeadlineError extends Error {
  constructor() {
    super("Read deadline exceeded");
    this.name = "ReadDeadlineError";
  }
}

export async function readWithDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  if (controller.signal.aborted) throw new DOMException("Read cancelled", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = (): void => reject(new DOMException("Read cancelled", "AbortError"));
    controller.signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      // Settle first: an error-body parser may deliberately catch AbortError.
      reject(new ReadDeadlineError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (cancel) controller.signal.removeEventListener("abort", cancel);
  }
}
