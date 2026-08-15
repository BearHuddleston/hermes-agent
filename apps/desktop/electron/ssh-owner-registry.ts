export class SshOwnerRegistry<T> {
  private readonly active = new Map<string, T>()
  private readonly closing = new Map<string, T>()
  private readonly attempts = new Map<string, Promise<boolean>>()

  get size(): number {
    return new Set([...this.active.keys(), ...this.closing.keys()]).size
  }

  get(scope: string): T | undefined {
    return this.active.get(scope)
  }

  getClosing(scope: string): T | undefined {
    return this.closing.get(scope)
  }

  set(scope: string, state: T): void {
    const closing = this.closing.get(scope)

    if (closing && closing !== state) {
      throw new Error(`SSH owner scope is still closing: ${scope || '<global>'}`)
    }

    this.closing.delete(scope)
    this.active.set(scope, state)
  }

  keys(): IterableIterator<string> {
    return new Set([...this.active.keys(), ...this.closing.keys()]).values()
  }

  promises(): Promise<boolean>[] {
    return [...this.attempts.values()]
  }

  async teardown(scope: string, expected: T | undefined, cleanup: (state: T) => Promise<void>): Promise<boolean> {
    let state = this.active.get(scope)

    if (!state) {
      state = this.closing.get(scope)
    }

    if (!state || (expected && state !== expected)) {
      return false
    }

    if (this.active.get(scope) === state) {
      this.active.delete(scope)
      this.closing.set(scope, state)
    }

    const inFlight = this.attempts.get(scope)

    if (inFlight) {
      return inFlight
    }

    const attempt = (async () => {
      await cleanup(state)

      if (this.closing.get(scope) === state) {
        this.closing.delete(scope)
      }

      return true
    })()

    this.attempts.set(scope, attempt)

    try {
      return await attempt
    } finally {
      if (this.attempts.get(scope) === attempt) {
        this.attempts.delete(scope)
      }
    }
  }

  async forceCleanup(cleanup: (state: T) => Promise<void>): Promise<void> {
    const snapshot = new Map<string, T>([...this.closing.entries(), ...this.active.entries()])

    for (const [scope, state] of snapshot) {
      if (this.active.get(scope) === state) {
        this.active.delete(scope)
        this.closing.set(scope, state)
      }
    }

    const results = await Promise.allSettled(
      [...snapshot.entries()].map(async ([scope, state]) => {
        await cleanup(state)

        if (this.closing.get(scope) === state) {
          this.closing.delete(scope)
        }
      })
    )

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(result => result.reason),
        'One or more SSH owners could not be force-cleaned.'
      )
    }
  }
}

export function refreshSshOwner<T extends { ssh: unknown }>(
  registry: SshOwnerRegistry<T>,
  scope: string,
  next: T
): T {
  const current = registry.get(scope)

  if (current && current.ssh === next.ssh) {
    Object.assign(current, next)

    return current
  }

  registry.set(scope, next)

  return next
}
