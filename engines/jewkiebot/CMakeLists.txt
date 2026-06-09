cmake_minimum_required(VERSION 3.14)
project(chess_engine)

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g")

set(ENGINE_VERSION "dev" CACHE STRING "Version of the engine")
add_compile_definitions(ENGINE_VERSION="${ENGINE_VERSION}")

find_package(Threads REQUIRED)

set(ENGINE_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_library(board STATIC src/board.cpp)
add_library(move STATIC src/move.cpp)
add_library(evaluator STATIC src/evaluator.cpp)
add_library(transposition_table STATIC src/transpositionTable.cpp)
add_library(search STATIC src/search.cpp src/timeManager.cpp)
add_library(book STATIC src/book.cpp)
add_library(core_engine STATIC src/engine.cpp)
add_library(bench STATIC src/bench.cpp)

target_include_directories(board PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(move PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(evaluator PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(transposition_table PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(search PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(book PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(core_engine PUBLIC ${ENGINE_INCLUDE_DIR})
target_include_directories(bench PUBLIC ${ENGINE_INCLUDE_DIR})

target_link_libraries(board PUBLIC Threads::Threads)
target_link_libraries(evaluator PUBLIC move board)
target_link_libraries(search PUBLIC evaluator transposition_table board move Threads::Threads)
target_link_libraries(book PUBLIC board move)
target_link_libraries(core_engine PUBLIC board move evaluator transposition_table search book)
target_link_libraries(bench PUBLIC core_engine)

add_executable(jewkiebot src/main.cpp)
target_include_directories(jewkiebot PRIVATE ${ENGINE_INCLUDE_DIR})
target_link_libraries(jewkiebot PRIVATE core_engine bench)

enable_testing()

add_executable(test_board_move tests/board_move_tests.cpp)
add_executable(test_eval tests/eval_test.cpp)
add_executable(test_search tests/search_test.cpp)
add_executable(test_transposition_table tests/transposition_table_test.cpp)
add_executable(test_book tests/book_test.cpp)
add_executable(test_time_manager tests/time_manager_test.cpp)

foreach (test_exe IN ITEMS test_board_move test_eval test_search test_transposition_table test_book test_time_manager)
    target_link_libraries(${test_exe} PRIVATE core_engine)
    target_link_options(${test_exe} PRIVATE -static -static-libgcc -static-libstdc++)
endforeach ()

add_test(NAME board_move_tests COMMAND test_board_move)
set_tests_properties(board_move_tests PROPERTIES LABELS "tests")

add_test(NAME eval_test COMMAND test_eval)
set_tests_properties(eval_test PROPERTIES LABELS "tests")

add_test(NAME search_test COMMAND test_search)
set_tests_properties(search_test PROPERTIES LABELS "tests")

add_test(NAME transposition_table_test COMMAND test_transposition_table)
set_tests_properties(transposition_table_test PROPERTIES LABELS "tests")

add_test(NAME book_test COMMAND test_book)
set_tests_properties(book_test PROPERTIES LABELS "tests")
add_test(NAME time_manager_test COMMAND test_time_manager)
set_tests_properties(time_manager_test PROPERTIES LABELS "tests")

add_executable(perf_board_move tests/Performance/board_move_performance.cpp)
target_link_libraries(perf_board_move PRIVATE core_engine)
target_link_options(perf_board_move PRIVATE -static -static-libgcc -static-libstdc++)
add_test(NAME board_move_perf COMMAND perf_board_move)

set_tests_properties(board_move_perf PROPERTIES LABELS "performance")

add_executable(perf_search tests/Performance/search_performance.cpp)
target_link_libraries(perf_search PRIVATE core_engine)
target_link_options(perf_search PRIVATE -static -static-libgcc -static-libstdc++)
add_test(NAME search_perf COMMAND perf_search)
set_tests_properties(search_perf PROPERTIES LABELS "performance")

add_executable(perf_eval tests/Performance/eval_performance.cpp)
target_link_libraries(perf_eval PRIVATE core_engine)
target_link_options(perf_eval PRIVATE -static -static-libgcc -static-libstdc++)
add_test(NAME eval_perf COMMAND perf_eval)
set_tests_properties(eval_perf PROPERTIES LABELS "performance")