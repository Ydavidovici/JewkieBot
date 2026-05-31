import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { health, getLichessStatus } from "../services/api.js";

const BotContext = createContext(null);

const URLS = {
    'prod': 'https://jewkiebot.dev',
    'dev': 'https://jewkiebot.dev/dev',
};

export const BotProvider = ({ children }) => {
    // Determine the active target: 'prod' or 'dev'
    const [botTarget, setBotTarget] = useState("prod");
    
    const activeUrl = URLS[botTarget];

    // Store status objects for both environments
    const [statuses, setStatuses] = useState({
        prod: {
            health: null,
            lichess: null,
            error: null,
            lastChecked: null
        },
        dev: {
            health: null,
            lichess: null,
            error: null,
            lastChecked: null
        }
    });

    const fetchStatusForTarget = useCallback(async (target, url) => {
        try {
            // We use Promise.all to fetch health and lichess parallelly, without failing entirely if one errors.
            const [healthData, lichessData] = await Promise.all([
                health(url).catch(e => ({ error: true, message: e.message })),
                getLichessStatus(url).catch(e => ({ error: true, message: e.message }))
            ]);

            setStatuses(prev => ({
                ...prev,
                [target]: {
                    health: healthData.error ? null : healthData,
                    lichess: lichessData.error ? null : lichessData,
                    error: healthData.error ? healthData.message : null, // Surface health error primarily
                    lastChecked: new Date()
                }
            }));
        } catch (err) {
            setStatuses(prev => ({
                ...prev,
                [target]: {
                    health: null,
                    lichess: null,
                    error: err.message,
                    lastChecked: new Date()
                }
            }));
        }
    }, []);

    // Background polling effect - pings both targets every 3 seconds
    useEffect(() => {
        const poll = () => {
            fetchStatusForTarget("prod", URLS.prod);
            fetchStatusForTarget("dev", URLS.dev);
        };

        poll(); // Trigger initial fetch
        const intervalId = setInterval(poll, 3000);

        return () => clearInterval(intervalId); // Cleanup on unmount
    }, [fetchStatusForTarget]);

    const value = {
        botTarget,
        setBotTarget,
        urls: URLS,
        activeUrl,
        statuses,
        activeStatus: statuses[botTarget],
        refreshActive: () => fetchStatusForTarget(botTarget, activeUrl)
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
