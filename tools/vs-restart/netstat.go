package main

import (
	"strings"
)

func listeningPIDs(netstatOut, port string) []string {
	want := ":" + port
	seen := map[string]bool{}
	var pids []string
	for _, line := range strings.Split(netstatOut, "\n") {
		u := strings.ToUpper(line)
		if !strings.Contains(u, "LISTENING") && !strings.Contains(u, "LISTEN") {
			continue
		}
		if !strings.Contains(line, want+" ") && !strings.Contains(line, want+"\t") {
			// also match :3000 at end of local addr before spaces
			if !strings.Contains(line, want) {
				continue
			}
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid := fields[len(fields)-1]
		if pid == "0" || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}
