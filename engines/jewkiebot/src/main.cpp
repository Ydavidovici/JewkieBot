#include "main.h"
#include "board.h"
#include "bench.h"
#include <iostream>
#include <string>
#include <unordered_map>
#include <sstream>

using CommandHandler = void(*)(const std::string& line, Engine& engine);

static void handle_uci(const std::string& line, Engine& engine);
static void handle_isready(const std::string& line, Engine& engine);
static void handle_ucinewgame(const std::string& line, Engine& engine);
static void handle_quit(const std::string& line, Engine& engine);
static void handle_position(const std::string& line, Engine& engine);
static void handle_go(const std::string& line, Engine& engine);
static void handle_bench(const std::string& line, Engine& engine);
static void handle_eval(const std::string& line, Engine& engine);
static void handle_setoption(const std::string& line, Engine& engine);

static std::unordered_map<std::string, CommandHandler> UCI_COMMANDS = {
    {"uci", handle_uci},
    {"isready", handle_isready},
    {"ucinewgame", handle_ucinewgame},
    {"quit", handle_quit},
    {"position", handle_position},
    {"go", handle_go},
    {"bench", handle_bench},
    {"eval", handle_eval},
    {"setoption", handle_setoption},
};


static std::string trim(const std::string& s) {
    const auto first = s.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    const auto last = s.find_last_not_of(" \t\r\n");
    return s.substr(first, last - first + 1);
}

static std::vector<std::string> tokenize(const std::string& line) {
    std::istringstream iss(line);
    std::vector<std::string> tokens;
    std::string token;
    while (iss >> token) {
        tokens.push_back(token);
    }
    return tokens;
}

static void split_command(const std::string& line, std::string& cmd, std::string& rest) {
    std::istringstream iss(line);
    if (!(iss >> cmd)) {
        cmd.clear();
        rest.clear();
        return;
    }
    std::getline(iss, rest);
}

static bool dispatch_uci(const std::string& rawLine, Engine& engine) {
    std::string line = trim(rawLine);
    if (line.empty()) return true;

    std::string cmd;
    std::string rest;
    split_command(line, cmd, rest);

    if (cmd.empty()) return true;

    auto it = UCI_COMMANDS.find(cmd);
    if (it != UCI_COMMANDS.end()) {
        it->second(line, engine);
    }
    else {
        std::cout << "no dispatch\n";
    }
    return cmd != "quit";
}

static void handle_uci(const std::string& line, Engine& engine) {
    #ifndef ENGINE_VERSION
    #define ENGINE_VERSION "dev"
    #endif

    std::cout << "id name Chess-Engine v" << ENGINE_VERSION << "\n";
    std::cout << "id author Antigravity\n";

    // TODO: OwnBook advertises "default true" but is effectively off until a BookFile is
    // loaded. Consider advertising "default false" to match actual behaviour, or set
    // use_book=true only after a successful load (see TODO in main.h).
    std::cout << "option name OwnBook type check default true\n";
    std::cout << "option name BookFile type string default \n";
    std::cout << "option name BookMaxFullmove type spin default 20 min 1 max 200\n";
    std::cout << "uciok\n";
    std::cout.flush();
}

static void handle_setoption(const std::string& line, Engine& engine) {
    // Expected: "setoption name <Name> value <Value>" where Name/Value may contain spaces.
    auto npos = line.find(" name ");
    if (npos == std::string::npos) return;
    std::string after_name = line.substr(npos + 6);

    std::string name;
    std::string value;
    auto vpos = after_name.find(" value ");
    if (vpos == std::string::npos) {
        name = trim(after_name);
    } else {
        name = trim(after_name.substr(0, vpos));
        value = trim(after_name.substr(vpos + 7));
    }

    if (name == "BookFile") {
        if (value.empty()) {
            engine.getOpeningBook().clear();
            std::cout << "info string opening book cleared\n";
        } else if (engine.loadOpeningBook(value)) {
            std::cout << "info string opening book loaded ("
                      << engine.getOpeningBook().size() << " entries)\n";
        } else {
            std::cout << "info string failed to load opening book: " << value << "\n";
        }
    } else if (name == "OwnBook") {
        bool on = (value == "true" || value == "True" || value == "1");
        engine.setUseBook(on);
        std::cout << "info string OwnBook=" << (on ? "true" : "false") << "\n";
    } else if (name == "BookMaxFullmove") {
        try {
            engine.setBookMaxFullmove(std::stoi(value));
            std::cout << "info string BookMaxFullmove=" << engine.bookMaxFullmove() << "\n";
        } catch (...) {
            std::cout << "info string invalid BookMaxFullmove\n";
        }
    } else {
        std::cout << "info string unknown option: " << name << "\n";
    }
    std::cout.flush();
}

static void handle_isready(const std::string& line, Engine& engine) {
    std::cout << "readyok\n";
    std::cout.flush();
}

static void handle_ucinewgame(const std::string& line, Engine& engine) {
    std::cout << "newgame\n";
    engine.reset();
    std::cout.flush();
}

static void handle_quit(const std::string& line, Engine& engine) {}

static void handle_position(const std::string& line, Engine& engine) {
    std::string cmd, rest;
    split_command(line, cmd, rest);

    std::istringstream iss(rest);
    std::string token;
    iss >> token;

    if (token == "startpos") {
        engine.reset();
    }
    else if (token == "fen") {
        std::string placement, stm, castling, ep;
        int halfmove_clock = 0;
        int fullmove_number = 1;

        iss >> placement >> stm >> castling >> ep >> halfmove_clock >> fullmove_number;

        if (!placement.empty()) {
            std::ostringstream fen;
            fen << placement << ' '
                << stm << ' '
                << castling << ' '
                << ep << ' '
                << halfmove_clock << ' '
                << fullmove_number;

            bool ok = engine.setPosition(fen.str());
            if (!ok) {
                std::cout << "info string invalid FEN in position command\n";
                std::cout.flush();
            }
        }
    }
    else {
        return;
    }

    if (iss >> token && token == "moves") {
        std::string moveUci;
        while (iss >> moveUci) {
            if (!engine.applyMove(moveUci)) {
                std::cout << "info string failed to apply move " << moveUci << "\n";
                std::cout.flush();
                break;
            }
        }
    }
}

static void handle_eval(const std::string& line, Engine& engine) {
    int score = engine.evaluateCurrentPosition();

    std::cout << "Score: " << score << "\n";
    std::cout << "Eval Complete\n";
    std::cout.flush();
}

static void handle_go(const std::string& line, Engine& engine) {
    PlaySettings settings{};
    settings.depth = 8;
    settings.time_left_ms = 0;
    settings.increment_ms = 0;
    settings.moves_to_go = 0;

    std::istringstream iss(line);
    std::string token;

    int wtime = 0, btime = 0, winc = 0, binc = 0, movestogo = 0;
    int movetime = 0;
    bool infinite = false;

    while (iss >> token) {
        if (token == "go") continue;
        if (token == "depth") iss >> settings.depth;
        else if (token == "wtime") iss >> wtime;
        else if (token == "btime") iss >> btime;
        else if (token == "winc") iss >> winc;
        else if (token == "binc") iss >> binc;
        else if (token == "movestogo") iss >> movestogo;
        else if (token == "movetime") iss >> movetime;
        else if (token == "infinite") infinite = true;
    }

    bool whiteToMove = true;
    std::string fen = engine.getFEN();
    std::istringstream fenIss(fen);
    std::string boardPart, colorPart;
    if (fenIss >> boardPart >> colorPart) {
        if (colorPart == "b") whiteToMove = false;
    }

    if (movetime > 0) {
        settings.time_left_ms = movetime;
        settings.increment_ms = 0;
        settings.moves_to_go = 1;
    } else {
        settings.time_left_ms = whiteToMove ? wtime : btime;
        settings.increment_ms = whiteToMove ? winc : binc;
        settings.moves_to_go = movestogo;
    }

    if (infinite) {
        settings.depth = 64;
        settings.time_left_ms = 0;
    }

    // 4. Execute
    const std::string bestUci = engine.playMove(settings);
    std::cout << "bestmove " << bestUci << "\n";
    std::cout.flush();
}

static void handle_bench(const std::string& line, Engine& engine) {
    BenchSettings settings;

    settings.searchDepth = 9;
    settings.evalTimeMs = 2000;
    settings.runEval = true;
    settings.runSearch = true;
    settings.searchMode = BenchMode::FIXED_DEPTH;

    std::vector<std::string> tokens = tokenize(line);

    for (size_t i = 1; i < tokens.size(); ++i) {
        const std::string& token = tokens[i];

        if (token == "depth" && i + 1 < tokens.size()) {
            settings.searchMode = BenchMode::FIXED_DEPTH;
            settings.searchDepth = std::stoi(tokens[++i]);
        }
        else if (token == "movetime" && i + 1 < tokens.size()) {
            settings.searchMode = BenchMode::FIXED_TIME;
            settings.searchTimeMs = std::stoi(tokens[++i]);
        }
        else if (token == "eval" && i + 1 < tokens.size()) {
            settings.evalTimeMs = std::stoi(tokens[++i]);
        }
        else if (token == "noeval") {
            settings.runEval = false;
        }
        else if (token == "nosearch") {
            settings.runSearch = false;
        }
    }

    Bench::run(engine, settings);
}

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    Engine engine;
    engine.reset();

    std::string line;
    while (std::getline(std::cin, line)) {
        if (!dispatch_uci(line, engine)) {
            break;
        }
    }
    return 0;
}
