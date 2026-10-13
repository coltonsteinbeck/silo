/** Keep only an HTTP origin in telemetry: credentials and path/query tokens are private. */
export function redactUrlForTelemetry(value: string, base?: string): string {
  try {
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : '[invalid-url]';
  } catch {
    return '[invalid-url]';
  }
}

export function redactUrlSecurityMetadata(
  metadata: Record<string, unknown> | undefined,
  base: string
): Record<string, unknown> {
  if (!metadata) return {};
  return {
    ...metadata,
    ...(Object.hasOwn(metadata, 'location')
      ? {
          location:
            typeof metadata.location === 'string'
              ? redactUrlForTelemetry(metadata.location, base)
              : '[invalid-url]'
        }
      : {})
  };
}
