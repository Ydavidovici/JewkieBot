#include "perft.h"

uint64_t perft(Board& board, int depth) {
    if (depth == 0) return 1;

    MoveList moves;
    board.generatePseudoMoves(moves);

    uint64_t nodes = 0;
    for (const Move& move : moves) {
        if (!board.makeMove(move)) continue;  // left our own king in check
        nodes += perft(board, depth - 1);
        board.unmakeMove();
    }
    return nodes;
}

std::vector<std::pair<std::string, uint64_t>> perftDivide(Board& board, int depth) {
    std::vector<std::pair<std::string, uint64_t>> out;
    if (depth < 1) return out;

    MoveList moves;
    board.generatePseudoMoves(moves);

    for (const Move& move : moves) {
        if (!board.makeMove(move)) continue;
        out.emplace_back(move.toString(), perft(board, depth - 1));
        board.unmakeMove();
    }
    return out;
}
