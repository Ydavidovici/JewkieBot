import React from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useBot } from "../context/BotContext.jsx";
import { LayoutDashboard, Gamepad2, Settings, Activity, LineChart } from "lucide-react";

export default function Default() {
    const { botTarget, setBotTarget, statuses } = useBot();

    const renderStatusIndicator = (target) => {
        const isOnline = !!statuses[target]?.health;
        return (
            <div className={`w-3 h-3 rounded-full transition-all duration-300 ${isOnline ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]"}`} />
        );
    };

    return (
        <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
            {/* Premium Sidebar */}
            <aside className="w-64 flex flex-col bg-slate-900 border-r border-slate-800 shadow-2xl z-20">
                <div className="p-6 border-b border-slate-800">
                    <h1 className="text-2xl font-black bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent flex items-center gap-2 tracking-tight">
                        ♞ JewkieBot
                    </h1>
                </div>

                {/* Target Switcher */}
                <div className="p-4 border-b border-slate-800">
                    <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">Active Target</p>
                    <div className="flex flex-col gap-2">
                        <button 
                            onClick={() => setBotTarget("prod")}
                            className={`flex items-center justify-between px-3 py-2 rounded-md transition-all duration-200 ${botTarget === "prod" ? "bg-blue-600/20 border border-blue-500/50 text-blue-100 shadow-inner" : "hover:bg-slate-800 text-slate-400 border border-transparent"}`}
                        >
                            <span className="text-sm font-medium">Production Bot</span>
                            {renderStatusIndicator("prod")}
                        </button>
                        <button 
                            onClick={() => setBotTarget("dev")}
                            className={`flex items-center justify-between px-3 py-2 rounded-md transition-all duration-200 ${botTarget === "dev" ? "bg-purple-600/20 border border-purple-500/50 text-purple-100 shadow-inner" : "hover:bg-slate-800 text-slate-400 border border-transparent"}`}
                        >
                            <span className="text-sm font-medium">Development Bot</span>
                            {renderStatusIndicator("dev")}
                        </button>
                        <button 
                            onClick={() => setBotTarget("local")}
                            className={`flex items-center justify-between px-3 py-2 rounded-md transition-all duration-200 ${botTarget === "local" ? "bg-green-600/20 border border-green-500/50 text-green-100 shadow-inner" : "hover:bg-slate-800 text-slate-400 border border-transparent"}`}
                        >
                            <span className="text-sm font-medium">Local Environment</span>
                            {renderStatusIndicator("local")}
                        </button>
                    </div>
                </div>

                <nav className="flex-1 p-4 flex flex-col gap-2">
                    <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2 mt-2">Navigation</p>
                    
                    <NavLink to="/" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <LayoutDashboard size={18} /> Dashboard
                    </NavLink>
                    <NavLink to="/analysis" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <LineChart size={18} /> Game Analysis
                    </NavLink>
                    <NavLink to="/game" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Gamepad2 size={18} /> Play vs Engine
                    </NavLink>
                    <NavLink to="/lichess" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Settings size={18} /> Lichess Control
                    </NavLink>
                    <NavLink to="/benchmark" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Activity size={18} /> Diagnostics
                    </NavLink>
                </nav>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-950">
                <header className="h-16 border-b border-slate-800 flex items-center px-8 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${botTarget === 'prod' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                            <Activity size={18} />
                        </div>
                        <h2 className="text-lg font-semibold tracking-tight text-white">
                            {botTarget === 'prod' ? 'Production Environment' : 'Development Environment'}
                        </h2>
                    </div>
                    <div className="ml-auto flex items-center gap-4 text-sm font-medium">
                        {statuses[botTarget]?.health ? (
                            <span className="flex items-center gap-2 bg-green-500/10 text-green-400 px-4 py-1.5 rounded-full border border-green-500/20 shadow-[0_0_10px_rgba(34,197,94,0.1)]">
                                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> Connected to Backend
                            </span>
                        ) : (
                            <span className="flex items-center gap-2 bg-red-500/10 text-red-400 px-4 py-1.5 rounded-full border border-red-500/20">
                                <div className="w-2 h-2 rounded-full bg-red-500" /> Disconnected
                            </span>
                        )}
                    </div>
                </header>
                
                <div className="flex-1 overflow-auto p-8 relative">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}