package main

// Build stamps — set via ldflags:
// -X main.LauncherID=... -X main.Version=... -X main.GitCommit=... -X main.BuildTime=... -X main.StrategyVersion=...

var (
	Version         = "1.0.0"
	GitCommit       = ""
	BuildTime       = ""
	StrategyVersion = "with-trend-10s-sl020-v1"
)

func buildStamp() map[string]string {
	commit := GitCommit
	if commit == "" {
		commit = LauncherID
	}
	bt := BuildTime
	if bt == "" {
		bt = "unknown"
	}
	return map[string]string{
		"VERSION":          Version,
		"GIT_COMMIT":       commit,
		"BUILD_TIME":       bt,
		"STRATEGY_VERSION": StrategyVersion,
		"LAUNCHER":         LauncherID,
	}
}
