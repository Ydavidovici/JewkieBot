import React, { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { onUnauthorized, login } from "../services/api.js";

// Shows a login overlay whenever an API call returns 401 (no valid session).
// The SPA shell itself is public so it can render this gate; control actions
// require logging in, which sets the auth-service session cookie.
export default function LoginGate({ children }) {
    const [show, setShow] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        onUnauthorized(() => setShow(true));
    }, []);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(email, password);
            setShow(false);
            // Reload so every poller/page refetches with the cookie present.
            window.location.reload();
        } catch (_) {
            setError("Invalid email or password.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {children}
            {show && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
                    <form onSubmit={submit} className="w-80 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400"><Lock size={18} /></div>
                            <h2 className="text-lg font-bold text-white">Sign in</h2>
                        </div>
                        <p className="text-xs text-slate-400 -mt-2">This control plane requires authentication.</p>

                        <input
                            type="email" placeholder="Email" autoFocus value={email}
                            onChange={e => setEmail(e.target.value)}
                            className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500"
                        />
                        <input
                            type="password" placeholder="Password" value={password}
                            onChange={e => setPassword(e.target.value)}
                            className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500"
                        />

                        {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>}

                        <button type="submit" disabled={busy}
                            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2.5 rounded-lg text-sm font-bold transition-colors">
                            {busy ? "Signing in…" : "Sign in"}
                        </button>
                    </form>
                </div>
            )}
        </>
    );
}
