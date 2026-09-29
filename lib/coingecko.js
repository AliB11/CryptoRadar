'use strict';
/** Provider credentials stay on the server, never in query strings or HTML. */
function config() {
  const pro = process.env.COINGECKO_PRO_API_KEY || '';
  const demo = process.env.COINGECKO_DEMO_API_KEY || '';
  return {
    base: pro ? 'https://pro-api.coingecko.com/api/v3/' : 'https://api.coingecko.com/api/v3/',
    headers: pro ? { 'x-cg-pro-api-key': pro } : demo ? { 'x-cg-demo-api-key': demo } : {}
  };
}
function authenticatedFetch(fetcher = globalThis.fetch) {
  return (url, options = {}) => {
    const str = String(url);
    if (!str.startsWith('https://api.coingecko.com/api/v3/')) return fetcher(url, options);
    const cfg = config();
    return fetcher(cfg.base + str.slice('https://api.coingecko.com/api/v3/'.length), {
      ...options, headers: { ...options.headers, ...cfg.headers }
    });
  };
}
module.exports = { config, authenticatedFetch };
