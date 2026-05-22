// Generic envelope-unwrap helper. The merchant-service routes wrap most
// single-resource responses as {success: true, <key>: <value>}; some
// legacy paths return the bare resource. unwrapEnvelope returns the inner
// value when the named key exists and falls back to the response as-is so
// the SDK stays compatible with both shapes.

export function unwrapEnvelope<T>(response: unknown, key: string): T {
  if (
    response &&
    typeof response === 'object' &&
    key in (response as Record<string, unknown>)
  ) {
    return (response as Record<string, unknown>)[key] as T;
  }
  return response as T;
}
