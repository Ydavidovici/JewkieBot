export class ApiTransport {
    constructor({ baseUrl = "", token = null, defaultHeaders = {} } = {}) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.defaultHeaders = defaultHeaders;
    }

    async request(endpoint, options = {}) {
        const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;
        
        const headers = {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...this.defaultHeaders,
            ...options.headers,
        };

        if (this.token && !headers["Authorization"]) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }

        const fetchOptions = {
            ...options,
            headers,
            body: (options.body && typeof options.body === "object") ? JSON.stringify(options.body) : options.body
        };

        try {
            const res = await fetch(url, fetchOptions);
            
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            }

            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                return await res.json();
            }
            
            return await res.text();
        } catch (err) {
            console.error(`[ApiTransport] Request to ${url} failed:`, err?.message ?? err);
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

    async delete(endpoint, options = {}) {
        return this.request(endpoint, { ...options, method: "DELETE" });
    }
}