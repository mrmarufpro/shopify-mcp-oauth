// RFC 8252 §3 lists 127.0.0.1 and [::1] as the canonical loopback redirect hosts. Node's
// URL.hostname keeps the IPv6 brackets, so compare against "[::1]" literally. Clients in the
// wild also use "localhost" and other 127.0.0.0/8 addresses.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// RFC 3986 §3.1: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
const SCHEME_SHAPE = /^[a-z][a-z0-9+\-.]*$/;

// Private-use schemes are allowed (RFC 8252 §7.1), but a 302 to any of these would be a
// vulnerability: they execute script, expose local content, or hand off to arbitrary apps.
const DANGEROUS_SCHEMES = new Set([
  "javascript",
  "vbscript",
  "livescript",
  "mocha",
  "data",
  "blob",
  "file",
  "about",
  "view-source",
  "chrome",
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "jar",
  "ms-help",
  "ms-its",
  "ms-itss",
  "mhtml",
  "wyciwyg",
  "intent",
]);

export function validateRedirectUri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "redirect_uri must be a valid URL";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) {
    return `${url.protocol} redirect_uris are not allowed`;
  }
  if (scheme === "https") return null;
  if (scheme === "http") {
    if (isLoopbackHost(url.hostname)) return null;
    return "http:// redirect_uris are only allowed for loopback hosts (localhost, 127.0.0.0/8, ::1)";
  }
  if (!SCHEME_SHAPE.test(scheme)) {
    return `${url.protocol} is not a valid URI scheme`;
  }
  return null;
}

// RFC 8252 §7.3: the AS MUST accept any port on a loopback redirect_uri, because native
// clients bind an ephemeral one.
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  if (left.protocol !== right.protocol) return false;
  if (left.hostname !== right.hostname) return false;
  if (left.pathname !== right.pathname) return false;
  if (left.search !== right.search) return false;
  if (!LOOPBACK_HOSTS.has(left.hostname)) return left.port === right.port;
  return true;
}
