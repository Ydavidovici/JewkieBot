import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { health, getLichessStatus } from "../services/api.js";

const BotContext = createContext(null);

const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
export const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

// The environment is implied by the origin you're on — `dev.*` is the dev bot,
// localhost is local, anything else is prod. There is no in-app target switcher:
// each backend serves its own branch's frontend and same-origin API calls hit it.
const env = isLocal ? "local" : hostname.startsWith("dev.") ? "dev" : "prod";

// Empty base = same origin (the backend that served this page). For local Vite
// dev the backend is on a different port, so allow overrides.
const API_URL = import.meta.env.VITE_API_URL ?? "";
const DB_URL = import.meta.env.VITE_DB_URL ?? "";

export const BotProvider = ({ children }) => {
    const [status, setStatus] = useState({ health: null, lichess: null, error: null, lastChecked: null });

    const refresh = useCallback(async () => {
        const [healthData, lichessData] = await Promise.all([
            health(API_URL).catch(e => ({ error: true, message: e.message })),
            getLichessStatus(API_URL).catch(e => ({ error: true, message: e.message })),
        ]);
        setStatus({
            health: healthData.error ? null : healthData,
            lichess: lichessData.error ? null : lichessData,
            error: healthData.error ? healthData.message : null,
            lastChecked: new Date(),
        });
    }, []);

    // Poll the single backend that serves this app.
    useEffect(() => {
        refresh();
        const intervalId = setInterval(refresh, 3000);
        return () => clearInterval(intervalId);
    }, [refresh]);

    const value = {
        env,                  // "prod" | "dev" | "local"
        botTarget: env,       // back-compat alias for pages that label the env
        isLocal,
        activeUrl: API_URL,   // same-origin unless overridden for local dev
        activeDbUrl: DB_URL,
        activeStatus: status,
        refreshActive: refresh,
    };

    return (
        <BotContext.Provider value={value}>
            {children}
        </BotContext.Provider>
    );
};

// Hook for consuming the global Bot store
export const useBot = () => {
    const context = useContext(BotContext);
    if (!context) {
        throw new Error("useBot must be used within a BotProvider");
    }
    return context;
};
