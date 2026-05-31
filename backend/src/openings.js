export const OPENINGS = {
    // Categories
    "random_tactical": { name: "Random Tactical", type: "category", style: "tactical" },
    "random_positional": { name: "Random Positional", type: "category", style: "positional" },

    // Deep Tactical Openings
    "sicilian": {
        name: "Sicilian Defense: Najdorf",
        fen: "startpos",
        moves: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6"],
        style: "tactical"
    },
    "ruy_lopez": {
        name: "Ruy Lopez: Berlin Defense",
        fen: "startpos",
        moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "g8f6", "e8g8", "f6e4", "d2d4", "e4d6", "b5c6", "d7c6", "d4e5", "d6f5", "d1d8", "e8d8"],
        style: "tactical"
    },
    "kings_indian": {
        name: "King's Indian: Mar del Plata",
        fen: "startpos",
        moves: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6", "g1f3", "e8g8", "f1e2", "e7e5", "e8g8", "b8c6", "d4d5", "c6e7"],
        style: "tactical"
    },
    "grunfeld": {
        name: "Grünfeld Defense: Exchange",
        fen: "startpos",
        moves: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "d7d5", "c4d5", "f6d5", "e2e4", "d5c3", "b2c3", "f8g7", "f1c4", "c7c5", "g1e2", "e8g8", "e1g1", "b8c6", "c1e3"],
        style: "tactical"
    },

    // Deep Positional Openings
    "queens_gambit": {
        name: "Queen's Gambit Declined: Orthodox",
        fen: "startpos",
        moves: ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7", "e2e3", "e8g8", "g1f3", "h7h6", "g5h4"],
        style: "positional"
    },
    "qga": {
        name: "Queen's Gambit Accepted",
        fen: "startpos",
        moves: ["d2d4", "d7d5", "c2c4", "d5c4", "g1f3", "g8f6", "e2e3", "e7e6", "f1c4", "c7c5", "e1g1", "a7a6"],
        style: "positional"
    },
    "caro_kann": {
        name: "Caro-Kann: Advance Variation",
        fen: "startpos",
        moves: ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5", "g1f3", "e7e6", "f1e2", "c6c5", "c1e3"],
        style: "positional"
    },
    "french": {
        name: "French Defense: Advance",
        fen: "startpos",
        moves: ["e2e4", "e7e6", "d2d4", "d7d5", "e4e5", "c7c5", "c2c3", "b8c6", "g1f3", "d8b6", "a2a3"],
        style: "positional"
    },
    "nimzo_indian": {
        name: "Nimzo-Indian: Rubinstein",
        fen: "startpos",
        moves: ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "c7c5", "f1d3", "b8c6", "g1f3", "d7d5", "e1g1", "e8g8"],
        style: "positional"
    },
    "c4": {
        name: "English Opening: Symmetrical",
        fen: "startpos",
        moves: ["c2c4", "c7c5", "b1c3", "b8c6", "g2g3", "g7g6", "f1g2", "f8g7", "g1f3", "e7e6", "e1g1", "g8e7"],
        style: "positional"
    },
    "italian": {
        name: "Italian Game: Giuoco Pianissimo",
        fen: "startpos",
        moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "d2d3", "d7d6", "e1g1", "a7a6"],
        style: "positional"
    },
    "catalan": {
        name: "Catalan Opening: Closed",
        fen: "startpos",
        moves: ["d2d4", "g8f6", "c2c4", "e7e6", "g2g3", "d7d5", "f1g2", "f8e7", "g1f3", "e8g8", "e1g1"],
        style: "positional"
    }
};
