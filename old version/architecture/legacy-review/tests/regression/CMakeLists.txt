cmake_minimum_required(VERSION 3.24)

# Regression suite reuses replay determinism test
add_test(NAME test_regression_replay COMMAND test_replay)
