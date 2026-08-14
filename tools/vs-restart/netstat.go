package main

import (
	"strings"
)

func listeningPIDs(netstatOut, port string) []string {
	seen := map[string]bool{}
	var pids []string
	for _, line := range strings.Split(netstatOut, "\n") {
		u := strings.ToUpper(line)
		if !strings.Contains(u, "LISTENING") && !strings.Contains(u, "LISTEN") {
			continue
		}
		fields := strings.Fields(line)
		// Windows: TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  1234
		// Linux:   tcp  0.0.0.0:3000  0.0.0.0:*   LISTEN     1234/node
		if len(fields) < 4 {
			continue
		}
		local := fields[1]
		if strings.Contains(local, "://") && len(fields) > 3 {
			// rare alternate formats — keep scanning fields for host:port
			local = fields[1]
		}
		if !localAddrHasPort(local, port) {
			continue
		}
		pid := fields[len(fields)-1]
		if slash := strings.Index(pid, "/"); slash >= 0 {
			pid = pid[:slash]
		}
		pid = strings.TrimSpace(pid)
		if pid == "" || pid == "0" || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

func localAddrHasPort(local, port string) bool {
	local = strings.TrimSpace(local)
	if local == "" || port == "" {
		return false
	}
	// Exact suffix :3000 — not :30001
	if strings.HasSuffix(local, ":"+port) {
		return true
	}
	// IPv6 [::]:3000 already covered by ":"+port when written as [::]:3000
	return false
}
