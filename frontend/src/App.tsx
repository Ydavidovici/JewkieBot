import React from "react";
import { Routes, Route } from "react-router-dom";
import Default from "./layouts/Default.jsx";
import Home from "./pages/Home.jsx";
import Game from "./pages/Game.jsx";
import BenchmarkControl from "./pages/BenchmarkControl.jsx";
import LichessPage from "./pages/LichessPage.jsx";
import AnalysisPage from "./pages/AnalysisPage.jsx";
import SelfPlayPage from "./pages/SelfPlayPage.jsx";
import TasksPage from "./pages/TasksPage.jsx";

export default function App() {
    return (
        <Routes>
            <Route element={<Default />}>
                <Route path="/" element={<Home/>} />
                <Route path="/analysis" element={<AnalysisPage/>} />
                <Route path="/game" element={<Game/>} />
                <Route path="/selfplay" element={<SelfPlayPage/>} />
                <Route path="/selfplay/:taskId" element={<SelfPlayPage/>} />
                <Route path="/benchmark" element={<BenchmarkControl/>} />
                <Route path="/lichess" element={<LichessPage/>} />
                <Route path="/tasks" element={<TasksPage/>} />
            </Route>
        </Routes>
    );
}
