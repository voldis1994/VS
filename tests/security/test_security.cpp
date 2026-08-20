#include <gtest/gtest.h>
#include <fstream>
#include <regex>

TEST(SecurityTest, EnvExampleHasPlaceholders) {
    std::ifstream file(".env.example");
    ASSERT_TRUE(file.is_open());
    std::string content((std::istreambuf_iterator<char>(file)),
                         std::istreambuf_iterator<char>());
    EXPECT_NE(content.find("CHANGE_ME"), std::string::npos);
    EXPECT_EQ(content.find("sk-live"), std::string::npos);
}

TEST(SecurityTest, NoPlaintextSecretsInGitignore) {
    std::ifstream file(".gitignore");
    ASSERT_TRUE(file.is_open());
    std::string content((std::istreambuf_iterator<char>(file)),
                         std::istreambuf_iterator<char>());
    EXPECT_NE(content.find(".env"), std::string::npos);
}
