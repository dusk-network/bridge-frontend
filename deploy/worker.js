/**
 * The bridge's Worker on Cloudflare (wrangler.jsonc). Its files are served
 * from deploy/site/, the build, with the headers deploy/stage.js writes in
 * deploy/site/_headers, and this runs only for a request no file answers:
 * the page's routes are in its address's fragment (#/move/…, #/transfer/…),
 * which browsers never send, so anything else is missing, and nothing but
 * GET and HEAD is answered.
 */

/**
 * The headers deploy/headers gives every file, for its own answers: but the
 * policy, as none of them is a page, so none needs a source of any kind.
 */
export const HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

/**
 * An answer with no body, never cached.
 *
 * @param {number} status
 * @param {Record<string, string>} [headers]
 */
const answer = (status, headers = {}) =>
  new Response(null, {
    headers: { ...HEADERS, "Cache-Control": "no-store", ...headers },
    status,
  });

export default {
  /** @param {Request} request */
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return answer(405, { Allow: "GET, HEAD" });
    }

    return answer(404);
  },
};
