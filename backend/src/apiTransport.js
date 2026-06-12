export class ApiTransport {
    constructor({ baseUrl = "", token = null, defaultHeaders = {}, notifier = null, unwrapData = false } = {}) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.defaultHeaders = defaultHeaders;
        this.notifier = notifier;
        this.unwrapData = unwrapData;
    }

    async request(endpoint, options = {}) {
        const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;
        
        const isUrlSearch = options.body instanceof URLSearchParams;
        const isJsonBody = options.body && !isUrlSearch && typeof options.body === "object";

        const headers = {
            ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
            ...this.defaultHeaders,
            ...options.headers,
        };

        if (this.token && !headers["Authorization"]) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }

        const fetchOptions = {
            ...options,
            headers,
            body: isJsonBody ? JSON.stringify(options.body) : options.body
        };

        try {
            const res = await fetch(url, fetchOptions);
            
            if (!res.ok && options.throwOnError !== false) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            }

            if (options.rawResponse) {
                return res;
            }

            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                const json = await res.json();
                return (this.unwrapData && json?.data !== undefined) ? json.data : json;
            }
            
            return await res.text();
        } catch (err) {
            if (this.notifier) {
                this.notifier.error(`[ApiTransport] Request to ${url} failed`, { error: err?.message ?? String(err) });
            } else {
                console.error(`[ApiTransport] Request to ${url} failed:`, err?.message ?? err);
            }
            throw err;
        }
    }

    async get(endpoint, options = {}) {
        return this.request(endpoint, { ...options, method: "GET" });
    }

    async post(endpoint, body, options = {}) {
        return this.request(endpoint, { ...options, method: "POST", body });
    }

    async put(endpoint, body, options = {}) {
        return this.request(endpoint, { ...options, method: "PUT", body });
    }

    async patch(endpoint, body, options = {}) {
        return this.request(endpoint, { ...options, method: "PATCH", body });
    }

    async delete(endpoint, options = {}) {
        return this.request(endpoint, { ...options, method: "DELETE" });
    }
}