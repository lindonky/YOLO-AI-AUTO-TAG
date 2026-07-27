// Safe repository default. Desktop users configure URL and Key inside the app.
// Browser users should start local_proxy.py with UPSTREAM_API_URL and
// UPSTREAM_API_KEY environment variables instead of committing credentials.
const CONFIGS = {
    'gemini-3.6-flash': {
        url: '/api/proxy/custom',
        key: 'local-managed',
        model: 'gemini-3.6-flash'
    }
};
