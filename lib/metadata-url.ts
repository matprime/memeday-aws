import type { NextRequest } from "next/server";

// The returned uri is minted into an immutable asset, so a misconfigured
// NEXT_PUBLIC_APP_URL must not reach it. A Vercel project with the literal
// value "https://$VERCEL_URL" (the shell form, which Vercel does not expand)
// produced an NFT whose metadata nobody can fetch. The request origin is
// always right for the deployment that is serving the call, so it is the
// fallback whenever the env var is not a usable https URL.
export function metadataBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) {
    try {
      const { protocol, hostname } = new URL(env);
      const usable = protocol === "https:" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname);
      // A preview deployment must not stamp the production domain onto a
      // document only it can serve. Preview writes the row to the dev table and
      // production reads the prod table, so every uri built that way is a 404
      // that no retry can fix — and it is minted into an immutable asset.
      // Production is the one place the env value may differ from the host
      // being called, because that is where a canonical domain is the point.
      const sameHost = hostname === request.nextUrl.hostname;
      if (usable && (sameHost || process.env.VERCEL_ENV === "production")) return env;
      console.warn(
        `Ignoring NEXT_PUBLIC_APP_URL ${env} for a request to ${request.nextUrl.hostname}`
      );
    } catch {
      console.warn(`Ignoring unusable NEXT_PUBLIC_APP_URL: ${env}`);
    }
  }
  return request.nextUrl.origin;
}
