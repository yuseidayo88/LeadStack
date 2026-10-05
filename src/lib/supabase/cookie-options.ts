// All Auth/PKCE cookies are consumed server-side. The browser uses our JSON API.
export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") ?? false,
    sameSite: "lax" as const,
    path: "/",
  };
}
