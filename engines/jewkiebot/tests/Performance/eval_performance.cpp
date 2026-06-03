#include "board.h"
#include "evaluator.h"
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <sstream>
#include <cmath>
#include <iomanip>

struct TuningEntry {
    Board board;
    double result;
};

double sigmoid(double eval) {
    return 1.0 / (1.0 + std::pow(10.0, -eval / 400.0));
}

double calculateMSE(Evaluator& evaluator, const std::vector<TuningEntry>& dataset) {
    double totalError = 0.0;
    for (const auto& entry : dataset) {
        int eval = evaluator.evaluate(entry.board, entry.board.sideToMove());
        if (entry.board.sideToMove() == Color::BLACK) {
            eval = -eval;
        }

        double expected = sigmoid(eval);
        double error = entry.result - expected;
        totalError += error * error;
    }
    return totalError / dataset.size();
}

std::vector<TuningEntry> loadDataset(const std::string& filename) {
    std::vector<TuningEntry> dataset;
    std::ifstream file(filename);
    if (!file.is_open()) {
        std::cerr << "Could not open dataset file: " << filename << std::endl;
        return dataset;
    }

    std::string line;
    while (std::getline(file, line)) {
        if (line.empty()) continue;

        size_t c9_pos = line.find("c9 \"");
        if (c9_pos == std::string::npos) continue;

        std::string fen = line.substr(0, c9_pos - 1);
        
        size_t result_start = c9_pos + 4;
        size_t result_end = line.find("\"", result_start);
        std::string result_str = line.substr(result_start, result_end - result_start);

        double result = 0.5;
        if (result_str == "1.0" || result_str == "1-0") result = 1.0;
        else if (result_str == "0.0" || result_str == "0-1") result = 0.0;
        else if (result_str == "0.5" || result_str == "1/2-1/2") result = 0.5;

        Board board;
        board.loadFEN(fen);
        dataset.push_back({board, result});
    }

    return dataset;
}

int main(int argc, char** argv) {
    std::string datasetPath = "../../tools/dummy_dataset.epd";
    if (argc > 1) {
        datasetPath = argv[1];
    }

    std::cout << "Loading dataset from " << datasetPath << "..." << std::endl;
    std::vector<TuningEntry> dataset = loadDataset(datasetPath);
    std::cout << "Loaded " << dataset.size() << " positions." << std::endl;

    if (dataset.empty()) {
        return 1;
    }

    Evaluator evaluator;
    int numParams = evaluator.getParameterCount();
    std::cout << "Optimizing " << numParams << " parameters." << std::endl;

    double bestMSE = calculateMSE(evaluator, dataset);
    std::cout << "Initial MSE: " << std::fixed << std::setprecision(6) << bestMSE << std::endl;

    int maxEpochs = 100;
    for (int epoch = 1; epoch <= maxEpochs; ++epoch) {
        bool improved = false;
        std::cout << "Epoch " << epoch << " started." << std::endl;

        for (int p = 0; p < numParams; ++p) {
            int originalValue = evaluator.getParameter(p);
            
            evaluator.setParameter(p, originalValue + 1);
            evaluator.updateBlackTables();
            double msePlus = calculateMSE(evaluator, dataset);

            evaluator.setParameter(p, originalValue - 1);
            evaluator.updateBlackTables();
            double mseMinus = calculateMSE(evaluator, dataset);

            evaluator.setParameter(p, originalValue);
            evaluator.updateBlackTables();

            if (msePlus < bestMSE && msePlus <= mseMinus) {
                evaluator.setParameter(p, originalValue + 1);
                evaluator.updateBlackTables();
                bestMSE = msePlus;
                improved = true;
            } else if (mseMinus < bestMSE && mseMinus < msePlus) {
                evaluator.setParameter(p, originalValue - 1);
                evaluator.updateBlackTables();
                bestMSE = mseMinus;
                improved = true;
            }
        }

        std::cout << "Epoch " << epoch << " MSE: " << bestMSE << std::endl;
        
        if (!improved) {
            std::cout << "Converged! No improvements in this epoch." << std::endl;
            break;
        }
    }

    std::cout << "\nOptimization finished. New MSE: " << bestMSE << std::endl;
    std::cout << "Please inspect Evaluator variables or add a save function to write them to file." << std::endl;

    return 0;
}
