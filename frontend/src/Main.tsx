import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { BotProvider } from "./context/BotContext.jsx";
import LoginGate from "./components/LoginGate.jsx";
import "../styles/app.css";

const root = createRoot(document.getElementById("root"));

root.render(
    <BrowserRouter>
        <BotProvider>
            <LoginGate>
                <App />
            </LoginGate>
        </BotProvider>
    </BrowserRouter>
);
